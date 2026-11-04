/**
 * Desktop shell: runs the same local server as `npm start` inside the app and
 * shows the web app in a window. Bundled to electron-dist/main.cjs by esbuild.
 */
import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { configFile } from '../server/config';
import { startServer, type RunningServer } from '../server/app';

// A fixed port keeps the web address (and so the app's saved library / autosaved panes) the same
// on every launch; the browser ties that storage to the address. Unusual number to avoid clashes.
const PORT = Number(process.env.JSON_COMPARE_DESKTOP_PORT) || 48787;

let server: RunningServer | null = null;
let win: BrowserWindow | null = null;

function createWindow(url: string): void {
  win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    title: 'JSON Compare',
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => (win = null));

  // Links to other sites open in the normal browser, never inside the app window.
  const isOurs = (u: string) => u.startsWith(url);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target) && !isOurs(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!isOurs(target)) {
      event.preventDefault();
      if (/^https?:/i.test(target)) void shell.openExternal(target);
    }
  });
  void win.loadURL(`${url}/`);
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Show connections file in Finder', click: () => shell.showItemInFolder(configFile) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    // Needed on macOS for Cmd+C / V / X / A / Z to work in the editors.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main(): Promise<void> {
  app.setName('JSON Compare');
  buildMenu();
  try {
    // Packaged: <app>/Resources/app.asar (holds dist/). From a checkout (`npm run app`): the project folder.
    server = await startServer({ port: PORT, root: app.getAppPath(), logLevel: 'warn' });
  } catch (e) {
    const inUse = (e as NodeJS.ErrnoException).code === 'EADDRINUSE';
    dialog.showErrorBox(
      'JSON Compare could not start',
      inUse
        ? `Port ${PORT} is already in use. Another copy of JSON Compare may be running, or another program uses that port.\n\nQuit it and try again (or set JSON_COMPARE_DESKTOP_PORT to another number).`
        : String(e instanceof Error ? e.message : e),
    );
    app.quit();
    return;
  }
  if (!server.servesApp) {
    dialog.showErrorBox('JSON Compare could not start', `The web app is missing or out of date (${server.dist}). Rebuild the app with: npm run package:mac`);
    app.quit();
    return;
  }
  createWindow(server.url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // a second launch just focuses the first one
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => {
    if (!win && server?.servesApp) createWindow(server.url);
  });
  app.on('before-quit', () => {
    void server?.close();
  });
  void app.whenReady().then(main);
}
