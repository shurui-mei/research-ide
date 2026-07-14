import { app, dialog } from 'electron';
import electronSquirrelStartup from 'electron-squirrel-startup';
import { DISTRIBUTION_IDENTITY } from '../shared/distribution';
import { recordWindowsInstallerEvent, windowsSquirrelAction } from './install-lifecycle';

const WINDOWS_APP_USER_MODEL_ID = DISTRIBUTION_IDENTITY.windows.appUserModelId;
const squirrelAction = windowsSquirrelAction(process.platform, process.argv);

if (process.platform === 'win32') app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);

// Squirrel starts the executable during install, update, uninstall, and
// obsolete-version cleanup. Handle those events before importing the full
// application (and its native SQLite module), then quit immediately.
if (electronSquirrelStartup) {
  // Stock Squirrel does not expose an in-Setup choice UI. Record only the two
  // successful installation lifecycle entries; uninstall must not recreate
  // user data that the user may already have removed.
  if (squirrelAction === 'install' || squirrelAction === 'update') {
    try {
      recordWindowsInstallerEvent(app.getPath('userData'), squirrelAction, app.getVersion());
    } catch { /* Installer bookkeeping must never block Squirrel shortcut handling. */ }
  }
} else {
  void import('./application').then(({ runDesktopApplication }) => {
    runDesktopApplication();
  }).catch(() => {
    dialog.showErrorBox('Research IDE 无法启动', '主进程未能载入。请重新安装 Research IDE。');
    app.exit(1);
  });
}

export const mainBootstrapInternals = { WINDOWS_APP_USER_MODEL_ID, squirrelAction };
