import { app, BrowserWindow, dialog, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { registerIpc, type MainServices } from './ipc';
import { recoverStaleLinuxSingleton, StartupLogger } from './startup-guard';

let mainWindow: BrowserWindow | undefined;
let services: MainServices | undefined;
let quitAfterWindowClose = false;
let finalQuit = false;
let startupFailureShown = false;
let startupLogger: StartupLogger | undefined;
const productionIndex = path.resolve(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
const nativeSmokeTest = process.argv.includes('--research-ide-native-smoke');

function logStartup(event: string, details: Record<string, unknown> = {}): void {
  try { startupLogger?.write(event, details); } catch { /* Startup diagnostics must never crash the application. */ }
}

function showStartupFailure(kind: string, details: Record<string, unknown> = {}): void {
  logStartup(kind, details);
  if (startupFailureShown) return;
  startupFailureShown = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  dialog.showErrorBox(
    'Research IDE 无法启动',
    `应用未能完成启动。请查看 ${path.join(app.getPath('userData'), 'logs', 'startup.log')}，然后重新启动或重新安装应用。`,
  );
}

function isApplicationUrl(raw: string): boolean {
  try {
    const candidate = new URL(raw);
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const expected = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      return candidate.origin === expected.origin && candidate.pathname === expected.pathname && !candidate.username && !candidate.password;
    }
    return candidate.protocol === 'file:' && path.resolve(fileURLToPath(candidate)) === productionIndex && !candidate.search;
  } catch { return false; }
}

function isSafeExternalUrl(raw: string): boolean {
  try {
    const candidate = new URL(raw);
    return candidate.protocol === 'https:' && !candidate.username && !candidate.password;
  } catch { return false; }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1024, minHeight: 680, show: false,
    title: 'Research IDE', backgroundColor: '#111827',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
    },
  });
  const window = mainWindow;
  window.once('ready-to-show', () => {
    logStartup('window-ready');
    if (!window.isDestroyed()) window.show();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url, { activate: true });
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => { if (!isApplicationUrl(url)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!isApplicationUrl(url)) event.preventDefault(); });
  window.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame) showStartupFailure('renderer-load-failed', { errorCode, scheme: (() => { try { return new URL(validatedUrl).protocol; } catch { return 'invalid'; } })() });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    showStartupFailure('renderer-process-gone', { reason: details.reason, exitCode: details.exitCode });
  });
  window.on('unresponsive', () => showStartupFailure('window-unresponsive'));
  window.webContents.on('will-prevent-unload', (event) => {
    if (!mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning', title: 'Unsaved changes', message: 'This project has unsaved changes.',
      detail: 'Cancel to return to Research IDE, or discard the unsaved editor changes and close the window.',
      buttons: ['Cancel', 'Discard and close'], defaultId: 0, cancelId: 0, noLink: true,
    });
    // For will-prevent-unload, preventDefault means "ignore beforeunload and allow unload".
    if (choice === 1) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  services = registerIpc(window, app.getPath('userData'));
  const load = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    : window.loadFile(productionIndex);
  void load.catch(() => showStartupFailure('renderer-load-promise-rejected'));
  window.on('closed', () => {
    const current = services;
    services = undefined;
    if (mainWindow === window) mainWindow = undefined;
    const disposed = current?.dispose() ?? Promise.resolve();
    if (process.platform !== 'darwin' || quitAfterWindowClose) {
      void disposed.finally(() => { finalQuit = true; app.quit(); });
    }
  });
}

async function startApplication(): Promise<void> {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isApplicationUrl(details.url)) { callback({ responseHeaders: details.responseHeaders }); return; }
    const devConnect = MAIN_WINDOW_VITE_DEV_SERVER_URL ? ` ${new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin} ws: wss:` : '';
    const devScript = MAIN_WINDOW_VITE_DEV_SERVER_URL ? " 'unsafe-eval'" : '';
    const policy = `default-src 'self'; script-src 'self'${devScript}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'${devConnect}; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}

function runNativeSmokeTest(): void {
  void app.whenReady().then(() => {
    const database = new Database(':memory:');
    try {
      const row = database.prepare('SELECT 42 AS value').get() as { value: number };
      if (row.value !== 42) throw new Error('Unexpected SQLite smoke-test result');
    } finally {
      database.close();
    }
    process.stdout.write('RESEARCH_IDE_NATIVE_SMOKE_OK\n', () => app.exit(0));
  }).catch(() => {
    process.stderr.write('RESEARCH_IDE_NATIVE_SMOKE_FAILED\n');
    app.exit(1);
  });
}

function fatalStartup(): void {
  showStartupFailure('main-startup-failed');
  app.exit(1);
}

export function runDesktopApplication(): void {
  if (nativeSmokeTest) { runNativeSmokeTest(); return; }

  const userDataPath = app.getPath('userData');
  try {
    startupLogger = new StartupLogger(userDataPath);
    app.setAppLogsPath(path.join(userDataPath, 'logs'));
  } catch {
    dialog.showErrorBox('Research IDE 无法启动', '应用数据目录或启动日志目录不安全。Research IDE 已停止，以避免覆盖其他文件。');
    app.exit(1);
    return;
  }

  const singletonRecovery = recoverStaleLinuxSingleton(userDataPath);
  logStartup('startup-begin', { platform: process.platform, singletonRecovery });
  const ownsSingleInstance = app.requestSingleInstanceLock();
  if (!ownsSingleInstance) {
    logStartup('single-instance-not-acquired', { singletonRecovery });
    if (singletonRecovery === 'unsafe') {
      dialog.showErrorBox('Research IDE 无法启动', `检测到无法安全恢复的应用锁。请查看 ${path.join(userDataPath, 'logs', 'startup.log')}。`);
    }
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  void app.whenReady().then(startApplication).catch(fatalStartup);
  app.on('before-quit', (event) => {
    if (finalQuit) return;
    event.preventDefault();
    quitAfterWindowClose = true;
    if (mainWindow) { mainWindow.close(); return; }
    const current = services; services = undefined;
    void (current?.dispose() ?? Promise.resolve()).finally(() => { finalQuit = true; app.quit(); });
  });
  app.on('window-all-closed', () => { /* closed handler waits for child-process and database cleanup */ });
}
