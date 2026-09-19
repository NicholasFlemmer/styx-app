import { WebContentsView, net, session, shell, type BrowserWindow } from 'electron';
import { PREVIEW_VIEWPORTS, type PreviewDevice, isLocalDevUrl } from '@styx/core';
import { logger } from './logger';
import { PreviewProbe, type PreviewStatus } from './preview-probe';

/** Chromium net error codes that mean "nothing is listening (yet)": refused, reset, closed, empty response, aborted. */
const CONNECTION_ERRORS = new Set([-102, -101, -100, -324, -3]);

/** Any response means a server is there; a network error means it is not up yet. */
const netProbe = async (url: string): Promise<boolean> => {
  try {
    await net.fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(1500), redirect: 'manual' });
    return true;
  } catch {
    return false;
  }
};

/** The design window's own (in-memory) session; nothing Styx registers on the default session reaches it. */
export const PREVIEW_PARTITION = 'styx-preview';

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The design window: the running app rendered live inside Styx, beside the code.
 *
 * A native `WebContentsView` rather than an iframe or a `<webview>`. An iframe cannot work — the renderer's CSP
 * is `default-src 'self'`, so it could never load a dev server — and `<webview>` is deprecated and would run
 * inside the renderer process, which is exactly where untrusted page code should not be. A separate view also
 * means a crashing dev server cannot take the app down with it.
 *
 * The cost of being native is that it paints *above* the DOM: it would sit on top of the palette, a modal, the
 * grant sheet and toasts. So the renderer owns visibility — it reports `visible: false` whenever an overlay is
 * open — and this service simply obeys.
 */
export class PreviewService {
  private view: WebContentsView | null = null;
  private window: BrowserWindow | null = null;
  private loadedUrl: string | null = null;
  /** Whose page `loadedUrl` is: `preview.set` names the project, so a screenshot is only ever that project's. */
  private wantedProject: string | null = null;
  private loadedProject: string | null = null;
  /** The page's zoom: 1, or the frame's scale when the pane is smaller than the device (see `viewZoom`). */
  private zoom = 1;
  private readonly probe: PreviewProbe;

  constructor(
    private readonly deps: {
      mainWindow: () => BrowserWindow | null;
      /** Reported to the renderer as `preview.status` so the pane can say it is waiting rather than show an error page. */
      onStatus?: (status: PreviewStatus) => void;
      probe?: (url: string) => Promise<boolean>;
    },
  ) {
    this.probe = new PreviewProbe({
      probe: deps.probe ?? netProbe,
      onStatus: (s) => deps.onStatus?.(s),
      onReady: (url) => {
        const view = this.view;
        if (view === null) return;
        this.loadedUrl = url;
        this.loadedProject = this.wantedProject;
        void view.webContents
          .loadURL(url)
          .then(() => this.applyZoom())
          .catch((e: Error) => {
            logger.warn('preview: load failed', { url, error: e.message });
          });
      },
    });
  }

  /**
   * The one entry point: where the hole in the renderer's layout is, what to show in it, and whether to show it
   * at all. Called on layout changes, so it must be cheap and idempotent.
   */
  set(input: {
    projectId: string;
    visible: boolean;
    bounds: PreviewBounds;
    url: string;
    device: PreviewDevice;
  }): void {
    this.wantedProject = input.projectId;
    const url = input.url.trim() === '' ? null : normaliseUrl(input.url);
    if (url === null) {
      this.detach();
      return;
    }
    const win = this.deps.mainWindow();
    if (win === null || win.isDestroyed()) return;
    const view = this.ensure(win);
    // Covered by an overlay, or the Code tab is showing: hide rather than tear down, so the page keeps its state
    // and nothing reloads every time the palette opens.
    const visible = input.visible && input.bounds.width > 0 && input.bounds.height > 0;
    view.setVisible(visible);
    if (visible) {
      const content = win.getContentBounds();
      const bounds = deviceBounds(input.bounds, { width: content.width, height: content.height });
      view.setBounds(bounds);
      // From the bounds the view actually got, not the reported ones: a pixel lost to rounding would otherwise
      // become two CSS pixels at half scale, and the page would measure 391 instead of 393.
      this.zoom = viewZoom(bounds, input.device);
      this.applyZoom();
    }
    // A new URL is probed until it answers, then loaded; the same URL never reloads on a layout change.
    if (url !== this.probe.current()) {
      this.loadedUrl = null;
      this.probe.start(url);
    }
  }

  /** Reload the page; if it never loaded (server not up yet, or gave up), probe again instead. */
  reload(): void {
    if (this.loadedUrl !== null && this.view !== null) this.view.webContents.reload();
    else this.probe.restart();
  }

  /** Opens the previewed URL in the OS browser, where devtools and extensions live. */
  async openExternal(url: string): Promise<void> {
    const safe = normaliseUrl(url);
    if (safe === null) return;
    await shell.openExternal(safe);
  }

  /** What the view has actually loaded (the probe answered, the page opened) and for which project; null otherwise. */
  loaded(): { url: string; projectId: string } | null {
    if (this.view === null || this.loadedUrl === null || this.loadedProject === null) return null;
    return { url: this.loadedUrl, projectId: this.loadedProject };
  }

  /** A PNG of the loaded page (checkpoint screenshots); null when nothing is loaded or the capture fails. */
  async capture(): Promise<Buffer | null> {
    const view = this.view;
    if (view === null || this.loadedUrl === null) return null;
    try {
      const image = await view.webContents.capturePage();
      return image.isEmpty() ? null : image.toPNG();
    } catch (e) {
      logger.warn('preview: capture failed', { error: (e as Error).message });
      return null;
    }
  }

  /** Detaches on window close / app teardown. Kept separate from `set` so teardown never needs bounds. */
  detach(): void {
    this.probe.reset();
    this.loadedUrl = null;
    this.loadedProject = null;
    if (this.view === null) return;
    const win = this.window;
    if (win !== null && !win.isDestroyed()) win.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = null;
    this.window = null;
  }

  /** Chromium keeps zoom per origin and forgets it across loads, so it is re-applied after every load too. */
  private applyZoom(): void {
    const view = this.view;
    if (view === null || view.webContents.isDestroyed()) return;
    if (view.webContents.getZoomFactor() !== this.zoom) view.webContents.setZoomFactor(this.zoom);
  }

  private ensure(win: BrowserWindow): WebContentsView {
    if (this.view !== null && this.window === win) return this.view;
    this.detach();
    // Its own session: the page never shares the default session's protocol handlers (`styx-device://`) or its
    // display-media handler, and gets no permission at all — the design window could otherwise ask for the
    // simulator's capture the way the renderer does, or read the checkpoint pictures by URL.
    const ses = session.fromPartition(PREVIEW_PARTITION);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    const view = new WebContentsView({
      webPreferences: {
        // The previewed page is the user's own app, but it is still web content Styx does not control:
        // no node, isolated, sandboxed.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: PREVIEW_PARTITION,
      },
    });
    // A preview must never become a way to navigate Styx itself or spawn windows.
    view.webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternal(url);
      return { action: 'deny' };
    });
    // The server went away after loading (a dev server restart): back to probing rather than an error page.
    view.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (!isMainFrame || !CONNECTION_ERRORS.has(code)) return;
      this.loadedUrl = null;
      this.probe.restart();
    });
    win.contentView.addChildView(view);
    this.view = view;
    this.window = win;
    return view;
  }
}

/**
 * Where the view actually sits: the rectangle the renderer reported, trusted. The renderer owns the layout — a
 * preset draws a device frame around a screen slot at the device's real size and reports that slot — so main
 * only clamps to the window's content area, and a narrow window still shows as much as it can.
 */
export const deviceBounds = (
  reported: PreviewBounds,
  content: { width: number; height: number },
): PreviewBounds => {
  const x = Math.max(0, Math.min(Math.round(reported.x), content.width));
  const y = Math.max(0, Math.min(Math.round(reported.y), content.height));
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(reported.x + reported.width), content.width) - x),
    height: Math.max(0, Math.min(Math.round(reported.y + reported.height), content.height) - y),
  };
};

/**
 * A preset makes the view genuinely that wide rather than emulating a viewport: `enableDeviceEmulation`'s
 * `viewSize` does not change the page's layout viewport once the view is resized, so the page kept reporting the
 * pane's width. When the pane is smaller than the device the renderer shrinks the frame with a transform and
 * reports the scaled slot; zooming the page by the same factor keeps its layout viewport at the device's size,
 * so media queries, `innerWidth` and anything else the page measures still agree — a simulator at 50%.
 * The larger side maps to the larger side, so a rotated frame gets the same factor.
 */
export const viewZoom = (bounds: PreviewBounds, device: PreviewDevice): number => {
  if (device === 'desktop') return 1;
  const want = PREVIEW_VIEWPORTS[device];
  // Portrait or rotated: the view's width is the device's width or its height. The factor is exact (no rounding),
  // so `width / zoom` is the device width to the pixel — Chromium rounds `innerWidth`, and ±1 view pixel at
  // half scale would otherwise read as ±2 CSS pixels.
  const landscape = bounds.width > bounds.height;
  const shownWidth = landscape ? want.height : want.width;
  if (bounds.width <= 0 || bounds.width >= shownWidth) return 1;
  return bounds.width / shownWidth;
};

/** http/https only, and only a URL that parses: a preview must never be a file:// or app:// navigation. */
export const normaliseUrl = (raw: string): string | null => {
  const text = raw.trim();
  if (text === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  // Local servers only: the window renders as "the app", and a `dev.url` can come from a committed project file.
  if (!isLocalDevUrl(withScheme)) return null;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
};
