import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Provider CLIs that route through `styx wrap <name>` (plan §6). `styx` itself and the git credential helper are special. */
export const SHIM_TOOLS = ['vercel', 'gh', 'aws', 'gcloud', 'supabase', 'ssh'] as const;

export interface ShimPaths {
  dir: string;
  styx: string;
}

const posixWrap = (tool: string) => `#!/bin/sh
# Styx shim: authorises the command through the grant broker, then execs the real ${tool} with injected credentials.
exec env ELECTRON_RUN_AS_NODE=1 "$STYX_EXE" "$STYX_CLI" wrap ${tool} "$@"
`;

const posixStyx = `#!/bin/sh
exec env ELECTRON_RUN_AS_NODE=1 "$STYX_EXE" "$STYX_CLI" "$@"
`;

// TODO(git-credential): the CLI has no \`credential\` subcommand yet; git ignores helper failures, so this is inert until Phase 8.
const posixGitCredential = `#!/bin/sh
exec env ELECTRON_RUN_AS_NODE=1 "$STYX_EXE" "$STYX_CLI" credential "$@"
`;

const winWrap = (tool: string) =>
  `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%STYX_EXE%" "%STYX_CLI%" wrap ${tool} %*\r\n`;
const winStyx = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%STYX_EXE%" "%STYX_CLI%" %*\r\n`;
const winGitCredential = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%STYX_EXE%" "%STYX_CLI%" credential %*\r\n`;

/**
 * Writes `<userData>/bin/{styx,vercel,gh,aws,gcloud,supabase,ssh,git-credential-styx}` on startup. The scripts
 * read STYX_EXE / STYX_CLI from the session env, so the same dir serves dev and packaged builds.
 */
export function writeShims(userData: string, platform: NodeJS.Platform): ShimPaths {
  const dir = join(userData, 'bin');
  mkdirSync(dir, { recursive: true });
  const win = platform === 'win32';
  const write = (name: string, body: string) => {
    const file = join(dir, win ? `${name}.cmd` : name);
    writeFileSync(file, body);
    if (!win) chmodSync(file, 0o755);
    return file;
  };
  const styx = write('styx', win ? winStyx : posixStyx);
  for (const t of SHIM_TOOLS) write(t, win ? winWrap(t) : posixWrap(t));
  write('git-credential-styx', win ? winGitCredential : posixGitCredential);
  return { dir, styx };
}
