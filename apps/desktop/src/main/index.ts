import { app, dialog } from 'electron';
import electronSquirrelStartup from 'electron-squirrel-startup';

const WINDOWS_APP_USER_MODEL_ID = 'com.squirrel.research_ide.research-ide';

if (process.platform === 'win32') app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);

// Squirrel starts the executable during install, update, uninstall, and
// obsolete-version cleanup. Handle those events before importing the full
// application (and its native SQLite module), then quit immediately.
if (!electronSquirrelStartup) {
  void import('./application').then(({ runDesktopApplication }) => {
    runDesktopApplication();
  }).catch(() => {
    dialog.showErrorBox('Research IDE 无法启动', '主进程未能载入。请重新安装 Research IDE。');
    app.exit(1);
  });
}

export const mainBootstrapInternals = { WINDOWS_APP_USER_MODEL_ID };
