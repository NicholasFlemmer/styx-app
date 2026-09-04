import { app, BrowserWindow, nativeTheme, ipcMain } from 'electron';
import { join } from 'node:path';
import { colors } from '@styx/tokens';

const isMac = process.platform === 'darwin';

if (process.env['STYX_USER_DATA']) app.setPath('userData', process.env['STYX_USER_DATA']);

function createMainWindow(): BrowserWindow {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: colors[theme].bg,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 13 } }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { height: 38, color: colors[theme].s1, symbolColor: colors[theme].mu },
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

app.whenReady().then(() => {
  ipcMain.handle('styx:theme:resolved', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
  const win = createMainWindow();
  nativeTheme.on('updated', () => {
    const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('styx:theme:resolved', theme);
      if (!isMac) w.setTitleBarOverlay?.({ color: colors[theme].s1, symbolColor: colors[theme].mu });
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  void win;
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
