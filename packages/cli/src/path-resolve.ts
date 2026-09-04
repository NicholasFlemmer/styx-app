import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

/** Finds the real binary for a shim: first executable named `tool` on PATH outside the shim directory. */
export function resolveRealBinary(tool: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const shimDir = env['STYX_SHIM_DIR'] ? resolve(env['STYX_SHIM_DIR']) : null;
  const exts = platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    if (shimDir && resolve(dir) === shimDir) continue;
    for (const ext of exts) {
      const candidate = join(dir, tool + ext.toLowerCase());
      if (isExecutable(candidate)) return candidate;
      if (ext && isExecutable(join(dir, tool + ext))) return join(dir, tool + ext);
    }
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
