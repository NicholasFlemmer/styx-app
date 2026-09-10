import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  CommandInput,
  CommandName,
  CommandResult,
  EventName,
  EventPayload,
  ReadModelSnapshot,
} from '@styx/core/ipc/contract';
import type { StyxApi, StyxEnv } from '@styx/core/ipc/api';
import type { DeltaBatch } from '@styx/core/deltas';

/** Channel names duplicated from `CHANNELS` / `EVENT_CHANNEL` so the sandboxed preload stays dependency-free. */
const CMD = 'styx:cmd';
const STORE = 'styx:store';
const PTY = 'styx:pty';
const EVT = 'styx:evt';

interface BootEnv extends StyxEnv {
  resolvedTheme?: 'dark' | 'light';
}

/** Main passes `--styx-env=<base64 json>` via `additionalArguments`; env vars are the fallback for `electron-vite dev`. */
function readBootEnv(): BootEnv {
  const arg = process.argv.find((a) => a.startsWith('--styx-env='));
  if (arg) {
    try {
      return JSON.parse(Buffer.from(arg.slice('--styx-env='.length), 'base64').toString('utf8')) as BootEnv;
    } catch {
      /* fall through */
    }
  }
  const e = process.env;
  const out: BootEnv = {};
  if (e['STYX_FIXTURE']) out.fixture = e['STYX_FIXTURE'];
  if (e['STYX_SCREEN']) out.screen = e['STYX_SCREEN'];
  if (e['STYX_THEME'] === 'dark' || e['STYX_THEME'] === 'light' || e['STYX_THEME'] === 'system')
    out.theme = e['STYX_THEME'];
  if (e['STYX_CHROME'] === 'mac' || e['STYX_CHROME'] === 'win') out.chrome = e['STYX_CHROME'];
  if (e['STYX_NOW'] && Number.isFinite(Number(e['STYX_NOW']))) out.now = Number(e['STYX_NOW']);
  if (e['STYX_E2E'] === '1') out.e2e = true;
  return out;
}

const boot = readBootEnv();
const env: StyxEnv = {};
if (boot.fixture !== undefined) env.fixture = boot.fixture;
if (boot.screen !== undefined) env.screen = boot.screen;
if (boot.theme !== undefined) env.theme = boot.theme;
if (boot.chrome !== undefined) env.chrome = boot.chrome;
if (boot.now !== undefined) env.now = boot.now;
if (boot.e2e !== undefined) env.e2e = boot.e2e;

const search = (globalThis as unknown as { location?: { search: string } }).location?.search ?? '';
const popoutSessionId = new URLSearchParams(search).get('popout');
/** `?dock=1` is the cross-project agent dock: a third window kind beside main and pop-out. */
const isDock = new URLSearchParams(search).get('dock') === '1';

let resolvedTheme: 'dark' | 'light' = boot.resolvedTheme ?? 'dark';
const on = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
  const h = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
};
on<{ name: EventName; payload: unknown }>(EVT, (m) => {
  if (m.name === 'theme.resolved') {
    resolvedTheme = (m.payload as EventPayload<'theme.resolved'>).theme;
  }
});

const command = <N extends CommandName>(name: N, input: CommandInput<N>): Promise<CommandResult<N>> =>
  ipcRenderer.invoke(CMD, name, input) as Promise<CommandResult<N>>;

const api: StyxApi = {
  platform: process.platform as StyxApi['platform'],
  env,
  window: {
    kind: popoutSessionId ? 'popout' : isDock ? 'dock' : 'main',
    popoutSessionId,
    control(action) {
      void command(
        'window.control',
        popoutSessionId
          ? { window: 'popout', sessionId: popoutSessionId as never, action }
          : { window: isDock ? 'dock' : 'main', action },
      );
    },
  },
  command,
  async snapshot(): Promise<ReadModelSnapshot> {
    const r = await command('store.snapshot', {});
    if (!r.ok) throw new Error(`store.snapshot failed: ${r.error.code}: ${r.error.message}`);
    return r.value;
  },
  onDelta: (cb) => on<DeltaBatch>(STORE, cb),
  onEvent: <E extends EventName>(name: E, cb: (payload: EventPayload<E>) => void) =>
    on<{ name: EventName; payload: unknown }>(EVT, (m) => {
      if (m.name === name) cb(m.payload as EventPayload<E>);
    }),
  pty: {
    onData: (cb) => on<{ id: string; data: string; seq: number }>(PTY, (m) => cb(m.id, m.data)),
    onExit: (cb) =>
      on<{ name: EventName; payload: unknown }>(EVT, (m) => {
        if (m.name === 'pty.exit') {
          const p = m.payload as EventPayload<'pty.exit'>;
          cb(p.id, p.exitCode);
        }
      }),
    write: (id, data) => ipcRenderer.send(PTY, { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send(PTY, { id, resize: { cols, rows } }),
  },
  theme: {
    resolved: () => Promise.resolve(resolvedTheme),
    onResolved: (cb) =>
      on<{ name: EventName; payload: unknown }>(EVT, (m) => {
        if (m.name === 'theme.resolved') cb((m.payload as EventPayload<'theme.resolved'>).theme);
      }),
  },
};

contextBridge.exposeInMainWorld('styx', api);
