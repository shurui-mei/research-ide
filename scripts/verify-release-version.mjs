#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const EXPECTED_IDENTITY = Object.freeze({
  installId: 'org.researchide.desktop',
  windowsSquirrelPackage: 'research_ide',
  windowsAppUserModelId: 'com.squirrel.research_ide.research-ide',
  macOSBundleId: 'org.researchide.desktop',
  linuxPackage: 'research-ide',
});

function parseArguments(argv) {
  const result = {
    rootPackage: path.join(repositoryRoot, 'package.json'),
    desktopPackage: path.join(repositoryRoot, 'apps/desktop/package.json'),
    manifest: path.join(
      repositoryRoot,
      'apps/desktop/resources/distribution/install-manifest.json',
    ),
    tag: process.env.GITHUB_REF_TYPE === 'tag' ? (process.env.GITHUB_REF_NAME ?? '') : undefined,
  };
  const names = new Map([
    ['--root-package', 'rootPackage'],
    ['--desktop-package', 'desktopPackage'],
    ['--manifest', 'manifest'],
    ['--tag', 'tag'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = names.get(argv[index]);
    if (!key || !argv[index + 1])
      throw new Error(`Unknown or incomplete argument: ${argv[index] ?? ''}`);
    result[key] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function jsonFile(filePath, label) {
  let value;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${filePath}`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must contain a JSON object`);
  return value;
}

function validVersion(value) {
  if (typeof value !== 'string' || value.length > 128) return false;
  const match = VERSION_PATTERN.exec(value);
  if (!match) return false;
  if ([match[1], match[2], match[3]].some((part) => !Number.isSafeInteger(Number(part))))
    return false;
  return !(
    match[4]
      ?.split('.')
      .some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith('0')) ?? false
  );
}

export async function verifyReleaseVersion(options) {
  const [rootPackage, desktopPackage, manifest] = await Promise.all([
    jsonFile(options.rootPackage, 'Root package manifest'),
    jsonFile(options.desktopPackage, 'Desktop package manifest'),
    jsonFile(options.manifest, 'Installation manifest'),
  ]);
  if (!validVersion(rootPackage.version))
    throw new Error(`Root package version is not valid SemVer: ${String(rootPackage.version)}`);
  if (desktopPackage.version !== rootPackage.version) {
    throw new Error(
      `Version mismatch: root=${String(rootPackage.version)}, desktop=${String(desktopPackage.version)}`,
    );
  }
  if (manifest.version !== rootPackage.version) {
    throw new Error(
      `Version mismatch: root=${String(rootPackage.version)}, install-manifest=${String(manifest.version)}`,
    );
  }
  if (
    manifest.installId !== EXPECTED_IDENTITY.installId ||
    manifest.kind !== 'application-installation'
  ) {
    throw new Error(
      'Installation manifest does not describe the Research IDE application identity',
    );
  }
  const upgrade = manifest.upgradeIdentity;
  if (
    !upgrade ||
    upgrade.windowsSquirrelPackage !== EXPECTED_IDENTITY.windowsSquirrelPackage ||
    upgrade.windowsAppUserModelId !== EXPECTED_IDENTITY.windowsAppUserModelId ||
    upgrade.macOSBundleId !== EXPECTED_IDENTITY.macOSBundleId ||
    upgrade.linuxPackage !== EXPECTED_IDENTITY.linuxPackage
  )
    throw new Error('Installation manifest has inconsistent cross-platform upgrade identities');
  if (options.tag !== undefined && options.tag !== `v${rootPackage.version}`) {
    throw new Error(`Release tag ${options.tag} must exactly match v${rootPackage.version}`);
  }
  return rootPackage.version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const version = await verifyReleaseVersion(options);
    process.stdout.write(`Research IDE release metadata is consistent for ${version}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
