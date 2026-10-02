import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import crossSpawn from 'cross-spawn';

/**
 * The script behind an npm `.cmd` shim (`"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`) and the node to
 * run it with (the shim's own `node.exe` when it has one, else `node` on PATH). Null for any other `.cmd`.
 */
export const npmShimTarget = (
  cmdFile: string,
  read: (f: string) => string = (f) => readFileSync(f, 'utf8'),
  exists: (f: string) => boolean = existsSync,
): { node: string; script: string } | null => {
  if (!/\.cmd$/i.test(cmdFile)) return null;
  let text: string;
  try {
    text = read(cmdFile);
  } catch {
    return null;
  }
  const m = /"%(?:~?dp0%|dp0%)\\?([^"%]+\.[cm]?js)"\s+%\*/i.exec(text);
  if (!m?.[1]) return null;
  const dir = dirname(cmdFile);
  const script = join(dir, m[1].replace(/\\/g, '/'));
  if (!exists(script)) return null;
  const local = join(dir, 'node.exe');
  return { node: exists(local) ? local : 'node', script };
};

/**
 * Starts an agent CLI. On Windows an npm-installed CLI is a `.cmd` shim, which Node refuses to start without a shell,
 * and cmd.exe cannot carry a line break inside an argument (a multi-line first message would be cut short). So an npm
 * shim's script runs on node directly; any other `.cmd` goes through cross-spawn, which escapes every argument for
 * cmd.exe; a real `.exe` starts directly. Elsewhere this is plain `spawn`.
 */
export const spawnCli: typeof spawnChild = ((
  command: string,
  args: readonly string[],
  options: { env?: Record<string, string | undefined> },
) => {
  if (process.platform !== 'win32') return spawnChild(command, [...args], options);
  if (options.env) options = { ...options, env: onePathKey(options.env) };
  const file = resolveWin(command, options.env ?? process.env);
  // Not found: a plain spawn fails with ENOENT before `spawn`, as on every other platform (cross-spawn would hand it
  // to cmd.exe, which starts fine and only then says it is not recognised).
  if (file === null) return spawnChild(command, [...args], options);
  const shim = npmShimTarget(file);
  if (shim !== null) return spawnChild(shim.node, [shim.script, ...args], options);
  return /\.(cmd|bat)$/i.test(file)
    ? crossSpawn(file, [...args], options)
    : spawnChild(file, [...args], options);
}) as typeof spawnChild;

/** Where Windows would find `command`: the path itself, or the first PATH folder holding it with a PATHEXT ending. */
export const resolveWin = (
  command: string,
  env: Record<string, string | undefined>,
  exists: (f: string) => boolean = existsSync,
): string | null => {
  const exts = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const withExt = (base: string): string | null => {
    if (/\.[a-z0-9]+$/i.test(base) && exists(base)) return base;
    for (const e of exts) if (exists(base + e)) return base + e;
    for (const e of exts) if (exists(base + e.toLowerCase())) return base + e.toLowerCase();
    return null;
  };
  if (/[\\/]/.test(command)) return withExt(command);
  const path = Object.entries(env).find(([k]) => /^path$/i.test(k))?.[1] ?? '';
  for (const dir of path.split(';').filter(Boolean)) {
    const hit = withExt(join(dir, command));
    if (hit !== null) return hit;
  }
  return null;
};

/**
 * Windows keeps `Path` in the environment; setting `PATH` beside it leaves two, and a child (node-pty passes the block
 * as is) may read the old one. Keeps a single key, with the value Styx set: `PATH` when present, else whichever exists.
 * A no-op elsewhere.
 */
export const onePathKey = <T extends Record<string, string | undefined>>(
  env: T,
  platform: NodeJS.Platform = process.platform,
): T => {
  if (platform !== 'win32') return env;
  const keys = Object.keys(env).filter((k) => /^path$/i.test(k));
  if (keys.length < 2) return env;
  const value = env['PATH'] ?? env[keys[0] ?? 'Path'];
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!/^path$/i.test(k)) out[k] = v;
  out['PATH'] = value;
  return out as T;
};

/**
 * Stops a CLI and everything it started. On Windows a `.cmd` shim's process is cmd.exe: killing it alone would leave
 * the agent running, so the whole tree goes (`taskkill /T /F`).
 */
export const killTree = (proc: { pid?: number | undefined; kill(): boolean }): void => {
  if (process.platform === 'win32' && proc.pid !== undefined) {
    const r = spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    if (r.status === 0) return;
  }
  proc.kill();
};
