export const DISTRIBUTION_IDENTITY = {
  installId: 'org.researchide.desktop',
  productName: 'Research IDE',
  executableName: 'research-ide',
  windows: {
    squirrelPackageName: 'research_ide',
    appUserModelId: 'com.squirrel.research_ide.research-ide',
    setupExe: 'ResearchIDE-Setup.exe',
  },
  macos: {
    bundleId: 'org.researchide.desktop',
  },
  linux: {
    packageName: 'research-ide',
    launcherName: 'research-ide-launcher',
  },
} as const;

export type InstallerTransitionKind =
  'first-run' | 'same-version' | 'upgrade' | 'downgrade' | 'unknown';
