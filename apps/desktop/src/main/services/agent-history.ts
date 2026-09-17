import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { z } from 'zod';

/**
 * Where Claude Code and Codex have actually worked, read from the CLIs' own session history (the welcome-wizard
 * import t3code does; owner request, docs/handoff-discrepancies #93). Pure over injected fs so it is testable on
 * synthetic files; nothing here reads a credential, token or transcript body — only the first bytes of each
 * session file, for the `cwd` field.
 *
 * - Claude Code: `~/.claude/projects/<encoded-cwd>/<session>.jsonl` (`$CLAUDE_CONFIG_DIR/projects` when set). The
 *   directory name encodes the path lossily (`/` and `.` both become `-`), so it is never decoded: the `cwd` comes
 *   from the session records themselves. Every file in one directory names the same cwd, so the newest file that
 *   yields one settles the directory and the directory's newest file dates it.
 * - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`$CODEX_HOME/sessions` when set); the first line is
 *   `{"type":"session_meta","payload":{"cwd":…}}`. `history.jsonl` (older builds, no cwd) is never read.
 *
 * Budget: files older than `maxAgeMs` (by mtime) are skipped, at most `maxFiles` per CLI are looked at (newest
 * first, so the cap drops old work), and only the head (for Claude Code, at worst the tail as well) of each file is
 * read. Symlinked entries are followed only when they resolve inside the home directory. Paths that no longer exist
 * on disk are dropped.
 */

export type AgentHistorySource = 'claude' | 'codex';

export interface AgentHistoryDir {
  /** Absolute, normalised directory the CLI ran in; exists on disk. */
  path: string;
  /** The CLI whose latest session ran there. */
  source: AgentHistorySource;
  /** mtime of the newest session file that names the path. */
  lastActivityAt: number;
}

export interface AgentHistoryEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
}

export interface AgentHistoryFs {
  /** Entries of a directory; `[]` when it is missing or unreadable. */
  readDir: (dir: string) => Promise<AgentHistoryEntry[]>;
  /** The first `bytes` bytes of a file as utf8; `''` when unreadable. */
  readHead: (file: string, bytes: number) => Promise<string>;
  /** The last `bytes` bytes of a file as utf8; `''` when unreadable. */
  readTail: (file: string, bytes: number) => Promise<string>;
  /** Follows symlinks; `null` when missing. */
  stat: (p: string) => Promise<{ mtimeMs: number; isDirectory: boolean } | null>;
  /** Resolved path of a symlink; `null` when it dangles. */
  realPath: (p: string) => Promise<string | null>;
}

export interface AgentHistoryDeps extends AgentHistoryFs {
  home: string;
  /** `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME`. */
  env: NodeJS.ProcessEnv;
  now: number;
  maxAgeMs?: number;
  maxFiles?: number;
}

const DAY = 24 * 3_600_000;
/** Session files whose mtime is older than this are not read (six months). */
export const AGENT_HISTORY_MAX_AGE_MS = 183 * DAY;
/** Session files looked at (stat'ed) per CLI before the scan stops. */
export const AGENT_HISTORY_MAX_FILES = 2000;
/** First read of a session file: Codex's `session_meta` line names the cwd within its first few hundred bytes. */
export const AGENT_HISTORY_HEAD_BYTES = 4096;
/**
 * Second read when the first held no cwd: Claude Code session files open with queue and hook records (hook output
 * can run to several KB) and the first record with a `cwd` typically sits between 3 KB and 13 KB in.
 */
export const AGENT_HISTORY_HEAD_BYTES_MAX = 65_536;
/**
 * Last resort for a Claude Code file whose head holds no cwd (a first prompt with a pasted image puts `cwd` after
 * a megabyte of base64): every later record names the cwd too, so the tail is read and its last one taken.
 */
export const AGENT_HISTORY_TAIL_BYTES = 65_536;

const nonEmpty = (v: string | undefined): string | null => (v !== undefined && v !== '' ? v : null);

export const claudeProjectsDir = (home: string, env: NodeJS.ProcessEnv): string => {
  const configDir = nonEmpty(env['CLAUDE_CONFIG_DIR']);
  return configDir !== null ? join(configDir, 'projects') : join(home, '.claude', 'projects');
};

export const codexSessionsDir = (home: string, env: NodeJS.ProcessEnv): string => {
  const codexHome = nonEmpty(env['CODEX_HOME']);
  return codexHome !== null ? join(codexHome, 'sessions') : join(home, '.codex', 'sessions');
};

/** One JSONL record naming a working directory: Claude Code's `cwd`, Codex's `payload.cwd`. */
const cwdRecordSchema = z.union([
  z.object({ cwd: z.string().min(1) }).transform((r) => r.cwd),
  z.object({ payload: z.object({ cwd: z.string().min(1) }) }).transform((r) => r.payload.cwd),
]);

/**
 * The first working directory named in the head of a session file: complete lines are parsed as JSON; when none
 * carries a cwd (the record that does was cut by the read, or is preceded by a long one) the field is lifted from
 * the raw text — a JSON string literal, so escapes decode the same way.
 */
export const cwdFromHead = (head: string): string | null => {
  for (const line of head.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      continue; // a line the read cut short
    }
    const parsed = cwdRecordSchema.safeParse(record);
    if (parsed.success) return parsed.data;
  }
  return cwdFields(head)[0] ?? null;
};

/** The last working directory named in the tail of a session file (records there are cut at the front, not the field). */
export const cwdFromTail = (tail: string): string | null => cwdFields(tail).at(-1) ?? null;

/** Every complete `"cwd":"…"` field in a stretch of JSONL text, decoded as JSON string literals, in order. */
const cwdFields = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    if (m[1] === undefined) continue;
    try {
      const value: unknown = JSON.parse(m[1]);
      if (typeof value === 'string' && value !== '') out.push(value);
    } catch {
      /* not a complete string literal */
    }
  }
  return out;
};

interface SessionFile {
  path: string;
  mtimeMs: number;
}

interface Budget {
  /** Files stat'ed so far for this CLI. */
  files: number;
  maxFiles: number;
  cutoff: number;
  /** The home with its own symlinks resolved (macOS temp dirs live under `/var` → `/private/var`). */
  homeReal: string;
}

const inside = (p: string, home: string): boolean => p === home || p.startsWith(home + sep);

/**
 * Sub-directories and `.jsonl` files of `dir`, symlinks followed only inside the home. Files are stat'ed (that is
 * the per-CLI budget), the ones older than the cutoff dropped, the rest newest first.
 */
async function listDir(
  deps: AgentHistoryDeps,
  dir: string,
  budget: Budget,
): Promise<{ dirs: string[]; files: SessionFile[] }> {
  const dirs: string[] = [];
  const files: SessionFile[] = [];
  for (const entry of await deps.readDir(dir)) {
    const p = join(dir, entry.name);
    let kind = entry.kind;
    if (kind === 'symlink') {
      const real = await deps.realPath(p);
      if (real === null || !inside(real, budget.homeReal)) continue;
      const st = await deps.stat(p);
      if (st === null) continue;
      kind = st.isDirectory ? 'dir' : 'file';
    }
    if (kind === 'dir') {
      dirs.push(p);
      continue;
    }
    if (kind !== 'file' || !entry.name.endsWith('.jsonl')) continue;
    if (budget.files >= budget.maxFiles) continue;
    budget.files += 1;
    const st = await deps.stat(p);
    if (st === null || st.isDirectory || st.mtimeMs < budget.cutoff) continue;
    files.push({ path: p, mtimeMs: st.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return { dirs, files };
}

interface ReadPlan {
  headBytes: number;
  /** A second, longer head read when the first holds no cwd and the file goes on. */
  headBytesMax: number;
  /** A tail read when the heads hold no cwd; `0` for none. */
  tailBytes: number;
}
const CLAUDE_READS: ReadPlan = {
  headBytes: AGENT_HISTORY_HEAD_BYTES,
  headBytesMax: AGENT_HISTORY_HEAD_BYTES_MAX,
  tailBytes: AGENT_HISTORY_TAIL_BYTES,
};
/** `session_meta` is the first line; a rollout without it (older builds) is not read further. */
const CODEX_READS: ReadPlan = {
  headBytes: AGENT_HISTORY_HEAD_BYTES,
  headBytesMax: AGENT_HISTORY_HEAD_BYTES,
  tailBytes: 0,
};

/** The cwd a session file names, reading as little of it as the plan allows. */
async function cwdOfFile(deps: AgentHistoryDeps, file: string, plan: ReadPlan): Promise<string | null> {
  const head = await deps.readHead(file, plan.headBytes);
  const found = cwdFromHead(head);
  if (found !== null || Buffer.byteLength(head) < plan.headBytes) return found;
  if (plan.headBytesMax > plan.headBytes) {
    const more = cwdFromHead(await deps.readHead(file, plan.headBytesMax));
    if (more !== null) return more;
  }
  return plan.tailBytes > 0 ? cwdFromTail(await deps.readTail(file, plan.tailBytes)) : null;
}

/** Claude Code: one hit per project directory, the newest file that names a cwd settling it. */
async function claudeDirs(deps: AgentHistoryDeps, budget: Budget): Promise<AgentHistoryDir[]> {
  const root = claudeProjectsDir(deps.home, deps.env);
  const { dirs } = await listDir(deps, root, budget);
  // Newest project directories first (a directory's mtime moves when a session file is created in it), so the
  // file cap keeps recent work.
  const dated = await Promise.all(
    dirs.map(async (dir) => ({ dir, mtimeMs: (await deps.stat(dir))?.mtimeMs ?? 0 })),
  );
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs || a.dir.localeCompare(b.dir));
  const out: AgentHistoryDir[] = [];
  for (const { dir } of dated) {
    if (budget.files >= budget.maxFiles) break;
    const { files } = await listDir(deps, dir, budget);
    const newest = files[0];
    if (newest === undefined) continue;
    for (const file of files) {
      const cwd = await cwdOfFile(deps, file.path, CLAUDE_READS);
      if (cwd === null) continue;
      out.push({ path: cwd, source: 'claude', lastActivityAt: newest.mtimeMs });
      break;
    }
  }
  return out;
}

const byNameDesc = (a: string, b: string): number => b.localeCompare(a);

/** `sessions/YYYY/MM/DD` as the end of that day (UTC); `null` for anything else. */
export const dayDirEndsAt = (year: string, month: string, day: string): number | null => {
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) return null;
  return Date.UTC(Number(year), Number(month) - 1, Number(day) + 1);
};

/** Codex: one hit per rollout file (each session has its own cwd), newest day first. */
async function codexDirs(deps: AgentHistoryDeps, budget: Budget): Promise<AgentHistoryDir[]> {
  const root = codexSessionsDir(deps.home, deps.env);
  const out: AgentHistoryDir[] = [];
  const years = (await listDir(deps, root, budget)).dirs.sort(byNameDesc);
  for (const year of years) {
    const months = (await listDir(deps, year, budget)).dirs.sort(byNameDesc);
    for (const month of months) {
      const days = (await listDir(deps, month, budget)).dirs.sort(byNameDesc);
      for (const day of days) {
        if (budget.files >= budget.maxFiles) return out;
        // A day directory older than the cutoff cannot hold a fresh session: skip it without stat'ing its files.
        const parts = day.split(sep);
        const endsAt = dayDirEndsAt(parts.at(-3) ?? '', parts.at(-2) ?? '', parts.at(-1) ?? '');
        if (endsAt !== null && endsAt < budget.cutoff) continue;
        const { files } = await listDir(deps, day, budget);
        for (const file of files) {
          if (!file.path.split(sep).at(-1)?.startsWith('rollout-')) continue;
          const cwd = await cwdOfFile(deps, file.path, CODEX_READS);
          if (cwd !== null) out.push({ path: cwd, source: 'codex', lastActivityAt: file.mtimeMs });
        }
      }
    }
  }
  return out;
}

/** `/a/b/` → `/a/b`; a relative or empty path is not a working directory. */
const normalisePath = (p: string): string | null => {
  if (!isAbsolute(p)) return null;
  const n = normalize(p);
  const trimmed = n.length > 1 && n.endsWith(sep) ? n.slice(0, -1) : n;
  return trimmed === '' ? null : trimmed;
};

/**
 * Directories Claude Code and Codex have worked in, one row per path (the latest session wins, whichever CLI ran
 * it), existing on disk, most recent first.
 */
export async function agentHistoryDirs(deps: AgentHistoryDeps): Promise<AgentHistoryDir[]> {
  const maxFiles = deps.maxFiles ?? AGENT_HISTORY_MAX_FILES;
  const cutoff = deps.now - (deps.maxAgeMs ?? AGENT_HISTORY_MAX_AGE_MS);
  const homeReal = (await deps.realPath(deps.home)) ?? deps.home;
  const hits = [
    ...(await claudeDirs(deps, { files: 0, maxFiles, cutoff, homeReal })),
    ...(await codexDirs(deps, { files: 0, maxFiles, cutoff, homeReal })),
  ];
  const byPath = new Map<string, AgentHistoryDir>();
  for (const hit of hits) {
    const path = normalisePath(hit.path);
    if (path === null) continue;
    const prev = byPath.get(path);
    if (prev === undefined || hit.lastActivityAt > prev.lastActivityAt) byPath.set(path, { ...hit, path });
  }
  const out: AgentHistoryDir[] = [];
  for (const row of byPath.values()) {
    const st = await deps.stat(row.path);
    if (st?.isDirectory === true) out.push(row);
  }
  return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.path.localeCompare(b.path));
}

/** The first or last `bytes` of a file as utf8 (a cut multibyte sequence at the edge decodes to U+FFFD, harmlessly). */
async function readSpan(file: string, bytes: number, end: 'head' | 'tail'): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(file, 'r');
    const size = (await handle.stat()).size;
    const length = Math.min(bytes, size);
    const position = end === 'head' ? 0 : size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The real filesystem behind `AgentHistoryFs`; every failure reads as "nothing there". */
export const agentHistoryFs = (): AgentHistoryFs => ({
  readDir: async (dir) => {
    try {
      return (await readdir(dir, { withFileTypes: true })).map((e) => ({
        name: e.name,
        kind: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      }));
    } catch {
      return [];
    }
  },
  readHead: (file, bytes) => readSpan(file, bytes, 'head'),
  readTail: (file, bytes) => readSpan(file, bytes, 'tail'),
  stat: async (p) => {
    try {
      const s = await stat(p);
      return { mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
    } catch {
      return null;
    }
  },
  realPath: async (p) => {
    try {
      return await realpath(p);
    } catch {
      return null;
    }
  },
});
