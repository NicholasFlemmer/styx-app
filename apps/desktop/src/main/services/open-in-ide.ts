/**
 * How an IDE launcher recorded by DetectService (`IdeInstall.launcher`) is turned into a process spawn for
 * "Open in {IDE}" (`worktree.openInIde`, `project.create/clone` with "Open in … too"). Pure: index.ts hands the
 * result to execa. Three launcher shapes exist:
 *
 * - `open -a "WebStorm"` (macOS app bundles without a CLI shim: JetBrains, and VS Code-likes / Zed when their
 *   `code` / `cursor` / `windsurf` / `zed` command is not on PATH) → `open -a <App> <path>`;
 * - a `.cmd` / `.bat` shim on Windows (`…\bin\code.cmd`) → run through `cmd.exe` (Node refuses to spawn batch
 *   files directly), quoted as one command line;
 * - anything else is a plain binary (`code`, `cursor`, `windsurf`, `zed`, `nvim`, `…\webstorm64.exe`) → `<bin> <path>`.
 */
export interface LaunchSpec {
  file: string;
  args: string[];
  /** `true` only for Windows batch shims; the whole command line is then in `file`. */
  shell: boolean;
  /** Editors are handed off and left running; `open` returns on its own, so it is awaited instead. */
  detached: boolean;
}

const OPEN_A = /^open\s+-a\s+"?(.+?)"?\s*$/;

export function launchArgs(launcher: string, path: string, platform: NodeJS.Platform): LaunchSpec {
  const bundle = OPEN_A.exec(launcher);
  if (bundle?.[1] !== undefined)
    return { file: 'open', args: ['-a', bundle[1], path], shell: false, detached: false };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(launcher))
    return { file: `"${launcher}" "${path}"`, args: [], shell: true, detached: true };
  return { file: launcher, args: [path], shell: false, detached: true };
}
