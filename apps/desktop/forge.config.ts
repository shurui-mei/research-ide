import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { chmod, cp, copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DISTRIBUTION_IDENTITY } from './src/shared/distribution';

type RuntimePackage = {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const requireFromDesktop = createRequire(path.join(__dirname, 'package.json'));
const desktopPackage = requireFromDesktop('./package.json') as RuntimePackage;
if (typeof desktopPackage.version !== 'string') throw new Error('Desktop package version is missing');
const desktopVersion = desktopPackage.version;
const copiedRuntimeRoots = ['better-sqlite3'] as const;
const resourcesRoot = path.resolve(__dirname, 'resources');
const distributionResources = path.join(resourcesRoot, 'distribution');
const uninstallResources = path.join(resourcesRoot, 'uninstall');
const linuxLauncher = path.join(resourcesRoot, 'linux', 'research-ide-launcher');
const linuxDesktopTemplate = path.join(resourcesRoot, 'linux', 'research-ide.desktop.ejs');
const repositoryRoot = path.resolve(__dirname, '../..');
const linuxRootUninstaller = path.join(repositoryRoot, 'uninstall-research-ide-gui');
const linuxUninstallDesktop = path.join(repositoryRoot, 'Uninstall Research IDE.desktop');
const productDescription = 'A local-first desktop IDE for scholarly writing, literature, reproducible tools, and Codex collaboration.';
const linuxCategories: ('Development' | 'Education' | 'Office' | 'Science')[] = ['Development', 'Education', 'Office', 'Science'];
const linuxMakerOptions = {
  name: DISTRIBUTION_IDENTITY.linux.packageName,
  productName: DISTRIBUTION_IDENTITY.productName,
  genericName: 'Research Development Environment',
  description: 'Local-first research writing and development IDE',
  productDescription,
  bin: DISTRIBUTION_IDENTITY.linux.launcherName,
  categories: linuxCategories,
};

function moduleDestination(buildPath: string, moduleName: string): string {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(moduleName)) {
    throw new Error(`Refusing to package an invalid module name: ${moduleName}`);
  }
  return path.join(buildPath, 'node_modules', ...moduleName.split('/'));
}

async function copyRuntimeModule(
  moduleName: string,
  buildPath: string,
  resolver: NodeRequire,
  copied: Map<string, string>,
  optional = false,
): Promise<void> {
  let packageJsonPath: string;
  try {
    packageJsonPath = resolver.resolve(`${moduleName}/package.json`);
  } catch (error) {
    if (optional) return;
    throw new Error(`Cannot resolve production dependency ${moduleName}`, { cause: error });
  }

  const sourceRoot = path.dirname(packageJsonPath);
  const previousSource = copied.get(moduleName);
  if (previousSource) {
    if (previousSource !== sourceRoot) {
      throw new Error(`Conflicting installed versions of ${moduleName} cannot be flattened for packaging`);
    }
    return;
  }

  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as RuntimePackage;
  if (manifest.name !== moduleName) {
    throw new Error(`Resolved package ${String(manifest.name)} while packaging ${moduleName}`);
  }
  copied.set(moduleName, sourceRoot);

  const destination = moduleDestination(buildPath, moduleName);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(sourceRoot, destination, {
    recursive: true,
    force: true,
    dereference: true,
    // pnpm may expose nested dependency links. Dependencies are copied once,
    // explicitly, so following those links cannot duplicate a whole store.
    filter: (source) => {
      const relative = path.relative(sourceRoot, source);
      return relative === '' || !relative.split(path.sep).includes('node_modules');
    },
  });

  const childResolver = createRequire(packageJsonPath);
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    await copyRuntimeModule(dependency, buildPath, childResolver, copied);
  }
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {}).sort()) {
    await copyRuntimeModule(dependency, buildPath, childResolver, copied, true);
  }
}

async function stageRuntimeModules(buildPath: string): Promise<void> {
  const copied = new Map<string, string>();
  for (const moduleName of copiedRuntimeRoots) {
    await copyRuntimeModule(moduleName, buildPath, requireFromDesktop, copied);
  }
}

async function assertStagedRuntime(buildPath: string): Promise<void> {
  const requiredFiles = [
    path.join(buildPath, 'node_modules/better-sqlite3/package.json'),
    path.join(buildPath, 'node_modules/better-sqlite3/lib/index.js'),
    path.join(buildPath, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
    path.join(buildPath, 'node_modules/bindings/bindings.js'),
  ];
  for (const file of requiredFiles) {
    const details = await stat(file).catch(() => undefined);
    if (!details?.isFile() || details.size === 0) {
      throw new Error(`Packaged runtime dependency is missing or empty: ${path.relative(buildPath, file)}`);
    }
  }
}

async function findFile(root: string, filename: string, depth = 5): Promise<string | undefined> {
  if (depth < 0) return undefined;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === filename) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, filename, depth - 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function assertPackagedRuntime(outputPath: string, platform?: string): Promise<void> {
  const archive = await findFile(outputPath, 'app.asar');
  if (!archive) throw new Error(`Packaged application has no app.asar under ${outputPath}`);
  const unpackedNative = path.join(
    `${archive}.unpacked`,
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  );
  const details = await stat(unpackedNative).catch(() => undefined);
  if (!details?.isFile() || details.size === 0) {
    throw new Error(`Packaged application has no unpacked better-sqlite3 binary: ${unpackedNative}`);
  }
  const installManifest = await findFile(outputPath, 'install-manifest.json');
  if (!installManifest) throw new Error(`Packaged application has no Research IDE install manifest under ${outputPath}`);
  const manifest = JSON.parse(await readFile(installManifest, 'utf8')) as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1
    || manifest.installId !== DISTRIBUTION_IDENTITY.installId
    || manifest.kind !== 'application-installation'
    || manifest.version !== desktopVersion
    || manifest.productName !== DISTRIBUTION_IDENTITY.productName
    || manifest.executableName !== DISTRIBUTION_IDENTITY.executableName
  ) {
    throw new Error(`Packaged Research IDE install manifest is invalid: ${installManifest}`);
  }
  const upgradeIdentity = manifest.upgradeIdentity as Record<string, unknown> | undefined;
  if (
    upgradeIdentity?.windowsSquirrelPackage !== DISTRIBUTION_IDENTITY.windows.squirrelPackageName
    || upgradeIdentity.windowsAppUserModelId !== DISTRIBUTION_IDENTITY.windows.appUserModelId
    || upgradeIdentity.macOSBundleId !== DISTRIBUTION_IDENTITY.macos.bundleId
    || upgradeIdentity.linuxPackage !== DISTRIBUTION_IDENTITY.linux.packageName
  ) throw new Error(`Packaged Research IDE upgrade identity is invalid: ${installManifest}`);
  for (const script of ['uninstall-research-ide.sh', 'uninstall-research-ide.ps1', 'uninstall-research-ide-gui']) {
    if (!await findFile(outputPath, script)) throw new Error(`Packaged application has no ${script} under ${outputPath}`);
  }
  if (platform === 'linux') {
    const rootGui = path.join(outputPath, 'uninstall-research-ide-gui');
    const desktop = path.join(outputPath, 'Uninstall Research IDE.desktop');
    const [rootGuiDetails, desktopDetails, desktopSource] = await Promise.all([
      stat(rootGui).catch(() => undefined),
      stat(desktop).catch(() => undefined),
      readFile(desktop, 'utf8').catch(() => ''),
    ]);
    if (!rootGuiDetails?.isFile() || (rootGuiDetails.mode & 0o111) === 0) throw new Error('Packaged Linux GUI uninstaller is missing or not executable');
    if (!desktopDetails?.isFile() || (desktopDetails.mode & 0o111) === 0) throw new Error('Packaged Linux uninstall desktop entry is missing or not executable');
    if (!desktopSource.includes('Exec=/usr/bin/find %k -maxdepth 0 -execdir ./uninstall-research-ide-gui --desktop-file {} +')) {
      throw new Error('Packaged Linux uninstall desktop entry has an unexpected Exec boundary');
    }
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: DISTRIBUTION_IDENTITY.executableName,
    appBundleId: DISTRIBUTION_IDENTITY.macos.bundleId,
    appCategoryType: 'public.app-category.productivity',
    appCopyright: `Copyright © ${new Date().getFullYear()} Research IDE contributors`,
    extraResource: [distributionResources, uninstallResources],
    win32metadata: {
      CompanyName: 'Research IDE contributors',
      FileDescription: 'Research IDE',
      ProductName: 'Research IDE',
      InternalName: 'research-ide',
      OriginalFilename: 'research-ide.exe',
      'requested-execution-level': 'asInvoker',
    },
  },
  rebuildConfig: {
    force: true,
    onlyModules: ['better-sqlite3'],
  },
  makers: [
    new MakerSquirrel({
      name: DISTRIBUTION_IDENTITY.windows.squirrelPackageName,
      setupExe: DISTRIBUTION_IDENTITY.windows.setupExe,
      authors: 'Research IDE contributors',
      description: productDescription,
      noMsi: true,
    }),
    new MakerDMG({ format: 'ULFO' }),
    new MakerZIP({}, ['darwin', 'linux']),
    new MakerRpm({ options: { ...linuxMakerOptions, license: 'MIT' } }),
    new MakerDeb({ options: { ...linuxMakerOptions, section: 'science', priority: 'optional', desktopTemplate: linuxDesktopTemplate } }),
  ],
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      await stageRuntimeModules(buildPath);
    },
    packageAfterPrune: async (_forgeConfig, buildPath) => {
      await assertStagedRuntime(buildPath);
    },
    postPackage: async (_forgeConfig, packageResult) => {
      for (const outputPath of packageResult.outputPaths) {
        if (packageResult.platform === 'linux') {
          const launcherTarget = path.join(outputPath, 'research-ide-launcher');
          const uninstallerTarget = path.join(outputPath, 'uninstall-research-ide-gui');
          const desktopTarget = path.join(outputPath, 'Uninstall Research IDE.desktop');
          await copyFile(linuxLauncher, launcherTarget);
          await copyFile(linuxRootUninstaller, uninstallerTarget);
          await copyFile(linuxUninstallDesktop, desktopTarget);
          await chmod(launcherTarget, 0o755);
          await chmod(uninstallerTarget, 0o755);
          await chmod(desktopTarget, 0o755);
          await chmod(path.join(outputPath, 'resources', 'uninstall', 'uninstall-research-ide-gui'), 0o755);
        }
        if (packageResult.platform !== 'win32') {
          const uninstaller = await findFile(outputPath, 'uninstall-research-ide.sh');
          if (!uninstaller) throw new Error(`Cannot find packaged POSIX uninstaller under ${outputPath}`);
          await chmod(uninstaller, 0o755);
          const guiUninstaller = await findFile(outputPath, 'uninstall-research-ide-gui');
          if (packageResult.platform === 'linux' && !guiUninstaller) throw new Error(`Cannot find packaged Linux GUI uninstaller under ${outputPath}`);
          if (guiUninstaller) await chmod(guiUninstaller, 0o755);
        }
        await assertPackagedRuntime(outputPath, packageResult.platform);
      }
    },
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
