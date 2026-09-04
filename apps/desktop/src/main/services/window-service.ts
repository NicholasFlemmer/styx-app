import { BrowserWindow, nativeTheme, screen, type BrowserWindowConstructorOptions } from 'electron';
import { join } from 'node:path';
import { colors } from '@styx/tokens';
import type { WindowBounds, WindowStateStore } from '../db/kv';

export interface WindowServiceDeps {
  windowState: WindowStateStore;
  preloadPath: string;
  rendererUrl: string | undefined; // dev server URL
  rendererFile: string; // built index.html
  platform: NodeJS.Platform;
  onAllClosed?: () => void;
}

const MAIN_DEFAULT: WindowBounds = { width: 1280, height: 800 };
const POPOUT_DEFAULT: WindowBounds = { width: 400, height: 500 };

/** Owns the main window and per-session pop-out chat windows (spec §3, §4.13). */
export class WindowService {
  private main: BrowserWindow | null = null;
  private readonly popouts = new Map<string, BrowserWindow>();

  constructor(private readonly deps: WindowServiceDeps) {}

  private theme(): 'dark' | 'light' {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }

  private baseOptions(bounds: WindowBounds, min: { w: number; h: number }): BrowserWindowConstructorOptions {
    const t = this.theme();
    const isMac = this.deps.platform === 'darwin';
    return {
      ...clampToDisplay(bounds),
      minWidth: min.w,
      minHeight: min.h,
      show: false,
      frame: false,
      backgroundColor: colors[t].bg,
      ...(isMac
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 13 } }
        : { titleBarStyle: 'hidden' as const, titleBarOverlay: { height: 38, color: colors[t].s1, symbolColor: colors[t].mu } }),
      webPreferences: { preload: this.deps.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    };
  }

  private harden(win: BrowserWindow): void {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
  }

  private load(win: BrowserWindow, query: Record<string, string> = {}): void {
    const qs = new URLSearchParams(query).toString();
    if (this.deps.rendererUrl) void win.loadURL(this.deps.rendererUrl + (qs ? `?${qs}` : ''));
    else void win.loadFile(this.deps.rendererFile, { query });
  }

  private persist(key: string, win: BrowserWindow): void {
    const save = () => {
      if (win.isDestroyed()) return;
      const b = win.getNormalBounds();
      const d = screen.getDisplayMatching(b);
      this.deps.windowState.set(key, { x: b.x, y: b.y, width: b.width, height: b.height, displayId: String(d.id), maximized: win.isMaximized() });
    };
    win.on('resize', save);
    win.on('move', save);
    win.on('close', save);
  }

  openMain(): BrowserWindow {
    if (this.main && !this.main.isDestroyed()) {
      this.main.focus();
      return this.main;
    }
    const saved = this.deps.windowState.get('main') ?? MAIN_DEFAULT;
    const win = new BrowserWindow(this.baseOptions(saved, { w: 1100, h: 680 }));
    this.harden(win);
    if (saved.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    this.persist('main', win);
    win.on('closed', () => {
      this.main = null;
      for (const p of this.popouts.values()) if (!p.isDestroyed()) p.close(); // closing main closes pop-outs
      this.popouts.clear();
      this.deps.onAllClosed?.();
    });
    this.load(win);
    this.main = win;
    return win;
  }

  mainWindow(): BrowserWindow | null {
    return this.main && !this.main.isDestroyed() ? this.main : null;
  }

  openPopout(sessionId: string): BrowserWindow {
    const existing = this.popouts.get(sessionId);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return existing;
    }
    const key = `popout:${sessionId}`;
    const saved = this.deps.windowState.get(key) ?? POPOUT_DEFAULT;
    const opts = this.baseOptions(saved, { w: 320, h: 400 });
    if (this.deps.platform !== 'darwin') opts.titleBarOverlay = { height: 32, color: colors[this.theme()].s1, symbolColor: colors[this.theme()].mu };
    const win = new BrowserWindow(opts);
    this.harden(win);
    win.once('ready-to-show', () => win.show());
    this.persist(key, win);
    win.on('closed', () => this.popouts.delete(sessionId));
    this.load(win, { popout: sessionId });
    this.popouts.set(sessionId, win);
    return win;
  }

  dockPopout(sessionId: string): void {
    const w = this.popouts.get(sessionId);
    if (w && !w.isDestroyed()) w.close();
    this.popouts.delete(sessionId);
  }

  popoutSessionIds(): string[] {
    return [...this.popouts.keys()];
  }

  allWindows(): BrowserWindow[] {
    return BrowserWindow.getAllWindows();
  }

  applyTheme(): void {
    const t = this.theme();
    for (const w of this.allWindows()) {
      w.setBackgroundColor(colors[t].bg);
      if (this.deps.platform !== 'darwin') w.setTitleBarOverlay?.({ color: colors[t].s1, symbolColor: colors[t].mu });
      w.webContents.send('styx:theme', t);
    }
  }

  control(win: BrowserWindow, action: 'minimize' | 'maximize' | 'close'): void {
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
    else win.close();
  }
}

/** Keeps a remembered window on a live display (spec §4.13 "remembers position"). */
export function clampToDisplay(b: WindowBounds): WindowBounds {
  if (b.x === undefined || b.y === undefined) return { width: b.width, height: b.height };
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const a = d.workArea;
    return b.x! + 40 < a.x + a.width && b.x! + b.width - 40 > a.x && b.y! + 20 < a.y + a.height && b.y! >= a.y - 10;
  });
  return visible ? b : { width: b.width, height: b.height };
}

export const rendererPaths = (dirname: string) => ({ preloadPath: join(dirname, '../preload/index.js'), rendererFile: join(dirname, '../renderer/index.html') });
