import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode } from '@styx/core';
import { styxMcpServerInherit, type AgentLaunch, type AgentLaunchContext } from './types';

/**
 * The OpenCode agent (mode) each Styx permission mode runs as. `build` and `plan` are OpenCode's own; the `styx-*`
 * ones exist only in the config below, for this process. The ACP runner switches between them with
 * `session/set_config_option` (OpenCode lists its primary agents as the `mode` option); the TUI gets `--agent`.
 */
export const OPENCODE_MODES: Readonly<Record<PermissionMode, string>> = {
  default: 'build',
  acceptEdits: 'styx-accept-edits',
  plan: 'plan',
  bypassPermissions: 'styx-bypass',
  dontAsk: 'styx-dont-ask',
  // OpenCode has no reviewer. Auto is the default for new lanes, so it must not mean "nothing asks": edits run,
  // commands ask (as for Gemini).
  auto: 'styx-accept-edits',
};

type Rule = 'ask' | 'allow' | 'deny';
type Rules = Readonly<Record<string, Rule>>;
/** The tools that change things or reach the network; everything else (read, grep, glob, list, todos) runs. */
const ASK: Rules = {
  edit: 'ask',
  bash: 'ask',
  webfetch: 'ask',
  websearch: 'ask',
  codesearch: 'ask',
};
/**
 * Files an "edits run" mode still asks about (paths relative to the worktree): Styx's policy file, and OpenCode's own
 * config, which would otherwise let an agent rewrite the rules it runs under for the next launch.
 */
const PROTECTED_EDITS: Rules = {
  '.styx/project.json': 'ask',
  'opencode.json': 'ask',
  'opencode.jsonc': 'ask',
  '.opencode/*': 'ask',
};

/** Where this machine's OpenCode keeps its own scratch files, which its stock rules let it read outside the worktree. */
export interface OpencodeHost {
  home: string;
  tmp: string;
  env: Readonly<Record<string, string | undefined>>;
}
const defaultHost = (): OpencodeHost => ({ home: homedir(), tmp: tmpdir(), env: process.env });

/** The project's instruction file OpenCode would read itself: the first of these at the worktree root. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'] as const;

export interface OpencodeConfigInput {
  /** The styx MCP server for the TUI fallback; null over ACP, where it travels in `session/new`. */
  mcp: { command: string; args: string[] } | null;
  /** Absolute paths OpenCode should read as instructions (the project's AGENTS.md, which the flag below hides). */
  instructions: readonly string[];
  host: OpencodeHost;
}

/**
 * What Styx layers over the user's own OpenCode config for one session, passed as `OPENCODE_CONFIG_CONTENT` (the
 * inline config; nothing is written to disk). The launch also sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
 *
 * Why both (checked with OpenCode 1.18.35):
 * - OpenCode's stock `build` agent allows every tool (`"*": "allow"` in `opencode debug agent build`), so Styx's
 *   default would otherwise never ask. The top-level `permission` makes edits, commands and web access ask in every
 *   agent, subagents included; `plan` is pinned back to no edits (the top-level `edit: ask` lands after its own deny,
 *   and the last matching rule wins). The three `styx-*` primary agents carry the other modes.
 * - Config objects merge key by key and keep the first file's key order, and the last matching rule wins. So a
 *   repository's `opencode.json` with `"agent": {"build": {"permission": {"edit": "allow", "*": "allow"}}}` keeps
 *   its trailing `"*": "allow"` after Styx's `edit: ask` and wins; its `.opencode/agent/*.md` and plugins likewise.
 *   `OPENCODE_DISABLE_PROJECT_CONFIG` makes OpenCode skip the project's `opencode.json` and `.opencode/` folders
 *   (and, with them, the project's AGENTS.md, which `instructions` brings back). The user's own global config is
 *   still read, as it is in a terminal.
 * - `external_directory` is pinned to ask (top level, `build`, `plan`, `styx-accept-edits`), except OpenCode's own
 *   tool-output and temp folders, which its stock rules allow so it can read back long command output.
 * - `styx-accept-edits` still asks before editing `.styx/project.json` or OpenCode's own config (checked live: a
 *   write to `notes.txt` ran, writes to `.opencode/agent/x.md` and `.styx/project.json` asked).
 *
 * `mcp` has no env block: OpenCode starts MCP servers with its own environment (checked), which already holds
 * `STYX_TOKEN`.
 */
export const opencodeConfig = ({ mcp, instructions, host }: OpencodeConfigInput): Record<string, unknown> => {
  const data = host.env['XDG_DATA_HOME'] || join(host.home, '.local', 'share');
  const external: Rules = {
    '*': 'ask',
    [join(data, 'opencode', 'tool-output', '*')]: 'allow',
    [join(host.tmp, 'opencode', '*')]: 'allow',
  };
  const asks = { ...ASK, external_directory: external };
  return {
    $schema: 'https://opencode.ai/config.json',
    ...(instructions.length > 0 ? { instructions: [...instructions] } : {}),
    permission: asks,
    agent: {
      build: { permission: asks },
      plan: {
        permission: { edit: { '*': 'deny', '.opencode/plans/*.md': 'allow' }, external_directory: external },
      },
      'styx-accept-edits': {
        mode: 'primary',
        description: 'Styx: edits run without asking; commands and web access ask.',
        permission: { ...asks, edit: { '*': 'allow', ...PROTECTED_EDITS } },
      },
      'styx-bypass': {
        mode: 'primary',
        description: 'Styx: nothing asks.',
        permission: { '*': 'allow' },
      },
      'styx-dont-ask': {
        mode: 'primary',
        description: 'Styx: edits, commands and web access are refused instead of asking.',
        permission: {
          edit: 'deny',
          bash: 'deny',
          webfetch: 'deny',
          websearch: 'deny',
          codesearch: 'deny',
          external_directory: 'deny',
          doom_loop: 'deny',
        },
      },
    },
    ...(mcp === null ? {} : { mcp: { styx: { type: 'local', command: [mcp.command, ...mcp.args] } } }),
  };
};

/**
 * OpenCode (`opencode`, opencode.ai) has two launches:
 *
 * - **ACP** (`opencode acp`, the `stream` runner) when DetectService saw the `acp` subcommand in `--help`: JSON-RPC
 *   over pipes with approvals (`session/request_permission`), the styx MCP server handed over in
 *   `session/new.mcpServers`, modes and models as `configOptions`. `opencode acp` takes no `--model`; the runner
 *   sets the session's model through the `model` config option once the session exists.
 * - **pty fallback** for a build without `acp`: the TUI in xterm, with the styx server in the inline config,
 *   `--agent` for the mode, `-m provider/model`, and the first message typed into the terminal.
 *
 * Neither writes into the worktree: Styx's part of the config rides in `OPENCODE_CONFIG_CONTENT`, the user's
 * `~/.config/opencode` is read as usual and never changed, and the project's `opencode.json` / `.opencode/` are not
 * loaded (see `opencodeConfig`). A value the user already exports in `OPENCODE_CONFIG_CONTENT` is replaced for this
 * process.
 *
 * Checked against OpenCode 1.18.35 (`npm install opencode-ai`, 2026-10-08): `opencode --help` / `acp --help`, the ACP
 * handshake (`initialize`, `session/new` with an MCP server, `session/set_config_option`), `opencode debug agent` for
 * the resulting rules (with and without a hostile project config), and turns on a free OpenCode Zen model with bash
 * and file-write permission requests and the AGENTS.md hand-back. UNVERIFIED: the TUI fallback (`--agent`, `-m`) was
 * only checked against `--help`, not run.
 */
export async function opencodeLaunch(
  ctx: AgentLaunchContext,
  host: OpencodeHost = defaultHost(),
): Promise<AgentLaunch> {
  const instruction = INSTRUCTION_FILES.map((f) => join(ctx.worktreePath, f)).find((p) => existsSync(p));
  const env = (mcp: OpencodeConfigInput['mcp']): Record<string, string> => ({
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(
      opencodeConfig({ mcp, instructions: instruction === undefined ? [] : [instruction], host }),
    ),
  });
  if (ctx.runner === 'stream' && ctx.capabilities['acp'] === true) {
    return {
      command: ctx.binary,
      args: ['acp'],
      env: env(null),
      typeFirstMessage: false,
      stream: { kind: 'acp' },
      cleanup: async () => undefined,
    };
  }
  const args: string[] = ['--agent', OPENCODE_MODES[ctx.permissionMode]];
  if (ctx.model) args.push('-m', ctx.model);
  return {
    command: ctx.binary,
    args,
    env: env(styxMcpServerInherit(ctx)),
    typeFirstMessage: true,
    cleanup: async () => undefined,
  };
}
