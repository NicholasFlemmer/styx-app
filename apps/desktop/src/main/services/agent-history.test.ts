import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_HISTORY_HEAD_BYTES,
  AGENT_HISTORY_HEAD_BYTES_MAX,
  AGENT_HISTORY_MAX_AGE_MS,
  agentHistoryDirs,
  agentHistoryFs,
  claudeProjectsDir,
  codexSessionsDir,
  cwdFromHead,
  cwdFromTail,
  dayDirEndsAt,
  type AgentHistoryDeps,
} from './agent-history';

const DAY = 24 * 3_600_000;
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);

const claudeLines = (cwd: string): string =>
  [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-06T17:24:20.341Z' }),
    JSON.stringify({ parentUuid: null, isSidechain: false, cwd, sessionId: 's1', type: 'user' }),
    JSON.stringify({ parentUuid: 'x', cwd, type: 'assistant' }),
  ].join('\n') + '\n';

const codexLines = (cwd: string, padding = 0): string =>
  JSON.stringify({
    timestamp: '2026-09-16T13:16:02.569Z',
    type: 'session_meta',
    payload: {
      id: 'sess',
      timestamp: '2026-09-16T13:15:58.771Z',
      cwd,
      base_instructions: 'x'.repeat(padding),
    },
  }) +
  '\n' +
  JSON.stringify({ type: 'response_item', payload: { role: 'user' } }) +
  '\n';

const write = (file: string, text: string, mtime: number): void => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  utimesSync(file, new Date(mtime), new Date(mtime));
};

const homes: string[] = [];
const makeHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'styx-agent-history-'));
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const deps = (home: string, extra: Partial<AgentHistoryDeps> = {}): AgentHistoryDeps => ({
  home,
  env: {},
  now: NOW,
  ...agentHistoryFs(),
  ...extra,
});

/** A Claude Code project directory with an encoded name that deliberately does not match the cwd it records. */
const claudeSession = (home: string, encoded: string, file: string, cwd: string, mtime: number): void =>
  write(join(home, '.claude', 'projects', encoded, file), claudeLines(cwd), mtime);

const codexSession = (
  home: string,
  day: string,
  file: string,
  cwd: string,
  mtime: number,
  padding = 0,
): void => write(join(home, '.codex', 'sessions', ...day.split('/'), file), codexLines(cwd, padding), mtime);

describe('agentHistoryDirs', () => {
  it('reads the cwd from Claude Code session records, never from the encoded directory name; one row per directory dated by its newest file', async () => {
    const home = makeHome();
    const project = join(home, 'code', 'my.app');
    mkdirSync(project, { recursive: true });
    // `-home-code-my-app` would decode to `/home/code/my/app`; the records say `my.app`.
    claudeSession(home, '-home-code-my-app', 'a.jsonl', project, NOW - 5 * DAY);
    claudeSession(home, '-home-code-my-app', 'b.jsonl', project, NOW - 2 * DAY);
    // A subagent journal below the project directory is never a session file.
    write(
      join(home, '.claude', 'projects', '-home-code-my-app', 's1', 'subagents', 'journal.jsonl'),
      JSON.stringify({ type: 'journal', cwd: join(home, 'elsewhere') }) + '\n',
      NOW,
    );
    // A directory whose files never name a cwd contributes nothing.
    write(
      join(home, '.claude', 'projects', '-home-nothing', 'c.jsonl'),
      JSON.stringify({ type: 'queue-operation' }) + '\n',
      NOW,
    );
    expect(await agentHistoryDirs(deps(home))).toEqual([
      { path: project, source: 'claude', lastActivityAt: NOW - 2 * DAY },
    ]);
  });

  it('finds a cwd that sits past the first 4 KB of a Claude Code file (hook output first), and the raw field of a record the read cut short', async () => {
    const home = makeHome();
    const project = join(home, 'code', 'big');
    mkdirSync(project, { recursive: true });
    const hook = JSON.stringify({
      parentUuid: null,
      attachment: { type: 'hook_non_blocking_error', stderr: 'e'.repeat(AGENT_HISTORY_HEAD_BYTES * 2) },
    });
    write(
      join(home, '.claude', 'projects', '-home-code-big', 'a.jsonl'),
      hook + '\n' + JSON.stringify({ cwd: project, type: 'user' }) + '\n',
      NOW - DAY,
    );
    // The first record itself is longer than the read, but its `cwd` field is inside the head.
    const wide = join(home, 'code', 'wide');
    mkdirSync(wide, { recursive: true });
    write(
      join(home, '.claude', 'projects', '-home-code-wide', 'a.jsonl'),
      JSON.stringify({ parentUuid: null, cwd: wide, message: { content: 'p'.repeat(200_000) } }) + '\n',
      NOW - 3 * DAY,
    );
    // A first prompt with a pasted image: `cwd` trails a megabyte of base64, so only the tail names it (its last
    // record wins there; an earlier `cwd` inside pasted text is not the session's).
    const pasted = join(home, 'code', 'pasted');
    mkdirSync(pasted, { recursive: true });
    write(
      join(home, '.claude', 'projects', '-home-code-pasted', 'a.jsonl'),
      JSON.stringify({
        parentUuid: null,
        type: 'user',
        message: { data: 'i'.repeat(AGENT_HISTORY_HEAD_BYTES_MAX * 2) },
        cwd: pasted,
      }) +
        '\n' +
        JSON.stringify({ type: 'assistant', message: { content: '"cwd":"/not/this"' }, cwd: pasted }) +
        '\n',
      NOW - 5 * DAY,
    );
    // Both ends silent (one huge record, cwd in the middle): not found; the directory contributes nothing.
    write(
      join(home, '.claude', 'projects', '-home-code-silent', 'a.jsonl'),
      JSON.stringify({
        a: 'x'.repeat(AGENT_HISTORY_HEAD_BYTES_MAX * 2),
        cwd: join(home, 'code'),
        b: 'y'.repeat(AGENT_HISTORY_HEAD_BYTES_MAX * 2),
      }) + '\n',
      NOW,
    );
    expect(await agentHistoryDirs(deps(home))).toEqual([
      { path: project, source: 'claude', lastActivityAt: NOW - DAY },
      { path: wide, source: 'claude', lastActivityAt: NOW - 3 * DAY },
      { path: pasted, source: 'claude', lastActivityAt: NOW - 5 * DAY },
    ]);
  });

  it('walks Codex sessions/YYYY/MM/DD newest first, reads payload.cwd from the session_meta line even when it is cut by the head, ignores history.jsonl and non-rollout files', async () => {
    const home = makeHome();
    const a = join(home, 'code', 'a');
    const b = join(home, 'code', 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    codexSession(
      home,
      '2026/09/16',
      'rollout-2026-09-16T15-15-58-x.jsonl',
      a,
      NOW - DAY,
      AGENT_HISTORY_HEAD_BYTES * 3,
    );
    codexSession(home, '2026/08/30', 'rollout-2026-08-30T10-00-00-y.jsonl', b, NOW - 18 * DAY);
    codexSession(home, '2026/08/30', 'notes.jsonl', join(home, 'code', 'ignored'), NOW);
    write(join(home, '.codex', 'history.jsonl'), JSON.stringify({ session_id: 'x', text: 'hi' }) + '\n', NOW);
    expect(await agentHistoryDirs(deps(home))).toEqual([
      { path: a, source: 'codex', lastActivityAt: NOW - DAY },
      { path: b, source: 'codex', lastActivityAt: NOW - 18 * DAY },
    ]);
  });

  it('skips files older than the age window (and Codex day directories that are older by name)', async () => {
    const home = makeHome();
    const fresh = join(home, 'fresh');
    const stale = join(home, 'stale');
    mkdirSync(fresh);
    mkdirSync(stale);
    const old = NOW - AGENT_HISTORY_MAX_AGE_MS - DAY;
    claudeSession(home, '-home-fresh', 'new.jsonl', fresh, NOW - DAY);
    claudeSession(home, '-home-fresh', 'old.jsonl', fresh, old);
    claudeSession(home, '-home-stale', 'old.jsonl', stale, old);
    codexSession(home, '2025/01/01', 'rollout-2025-01-01T00-00-00-z.jsonl', stale, old);
    // A file placed under a fresh day but touched long ago still goes by mtime.
    codexSession(home, '2026/09/10', 'rollout-2026-09-10T00-00-00-w.jsonl', stale, old);
    expect(await agentHistoryDirs(deps(home))).toEqual([
      { path: fresh, source: 'claude', lastActivityAt: NOW - DAY },
    ]);
    // The window is configurable.
    expect((await agentHistoryDirs(deps(home, { maxAgeMs: 400 * DAY }))).map((r) => r.path)).toEqual([
      fresh,
      stale,
    ]);
  });

  it('caps the files looked at per CLI, newest first', async () => {
    const home = makeHome();
    const dirs = ['p1', 'p2', 'p3'].map((n) => {
      const d = join(home, n);
      mkdirSync(d);
      return d;
    });
    // Project directory mtimes order them: p3 newest, then p2, then p1.
    dirs.forEach((d, i) => {
      claudeSession(home, `-home-p${i + 1}`, 'a.jsonl', d, NOW - (3 - i) * DAY);
      const projectDir = join(home, '.claude', 'projects', `-home-p${i + 1}`);
      utimesSync(projectDir, new Date(NOW - (3 - i) * DAY), new Date(NOW - (3 - i) * DAY));
    });
    codexSession(home, '2026/09/16', 'rollout-2026-09-16T00-00-00-a.jsonl', dirs[0]!, NOW - 10 * DAY);
    codexSession(home, '2026/09/17', 'rollout-2026-09-17T00-00-00-b.jsonl', dirs[1]!, NOW - 9 * DAY);
    // One file per CLI: Claude looks at its newest project directory only (p3); Codex at its newest day only
    // (p2, an older session than p2's Claude one, which the cap never reached).
    expect(await agentHistoryDirs(deps(home, { maxFiles: 1 }))).toEqual([
      { path: dirs[2], source: 'claude', lastActivityAt: NOW - DAY },
      { path: dirs[1], source: 'codex', lastActivityAt: NOW - 9 * DAY },
    ]);
    // Two files per CLI: Claude adds p2; Codex adds p1 (Claude's p1 file is past the cap).
    expect(await agentHistoryDirs(deps(home, { maxFiles: 2 }))).toEqual([
      { path: dirs[2], source: 'claude', lastActivityAt: NOW - DAY },
      { path: dirs[1], source: 'claude', lastActivityAt: NOW - 2 * DAY },
      { path: dirs[0], source: 'codex', lastActivityAt: NOW - 10 * DAY },
    ]);
    expect((await agentHistoryDirs(deps(home))).map((r) => r.path)).toEqual([dirs[2], dirs[1], dirs[0]]);
  });

  it('dedupes per path with the latest session winning across CLIs, and drops paths that no longer exist', async () => {
    const home = makeHome();
    const shared = join(home, 'shared');
    mkdirSync(shared);
    claudeSession(home, '-home-shared', 'a.jsonl', shared, NOW - 4 * DAY);
    codexSession(home, '2026/09/15', 'rollout-2026-09-15T00-00-00-a.jsonl', shared, NOW - DAY);
    codexSession(home, '2026/09/14', 'rollout-2026-09-14T00-00-00-b.jsonl', `${shared}/`, NOW - 6 * DAY);
    claudeSession(home, '-home-gone', 'a.jsonl', join(home, 'gone'), NOW);
    claudeSession(home, '-relative', 'a.jsonl', 'relative/path', NOW);
    // A cwd that is a file, not a directory, is not a project either.
    writeFileSync(join(home, 'file.txt'), '');
    claudeSession(home, '-home-file-txt', 'a.jsonl', join(home, 'file.txt'), NOW);
    expect(await agentHistoryDirs(deps(home))).toEqual([
      { path: shared, source: 'codex', lastActivityAt: NOW - DAY },
    ]);
  });

  it('honours CLAUDE_CONFIG_DIR and CODEX_HOME', async () => {
    const home = makeHome();
    const claudeConfig = join(home, 'cfg', 'claude');
    const codexHome = join(home, 'cfg', 'codex');
    const a = join(home, 'a');
    const b = join(home, 'b');
    mkdirSync(a);
    mkdirSync(b);
    write(join(claudeConfig, 'projects', '-home-a', 's.jsonl'), claudeLines(a), NOW - DAY);
    write(join(codexHome, 'sessions', '2026', '09', '16', 'rollout-x.jsonl'), codexLines(b), NOW - 2 * DAY);
    // The defaults hold other work that must not be read when the variables point elsewhere.
    claudeSession(home, '-home-default', 's.jsonl', join(home, 'cfg'), NOW);
    const env = { CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: codexHome };
    expect(claudeProjectsDir(home, env)).toBe(join(claudeConfig, 'projects'));
    expect(codexSessionsDir(home, env)).toBe(join(codexHome, 'sessions'));
    expect(claudeProjectsDir(home, { CLAUDE_CONFIG_DIR: '' })).toBe(join(home, '.claude', 'projects'));
    expect(codexSessionsDir(home, {})).toBe(join(home, '.codex', 'sessions'));
    expect(await agentHistoryDirs(deps(home, { env }))).toEqual([
      { path: a, source: 'claude', lastActivityAt: NOW - DAY },
      { path: b, source: 'codex', lastActivityAt: NOW - 2 * DAY },
    ]);
  });

  it('follows symlinked entries only when they resolve inside the home', async () => {
    const home = makeHome();
    const outside = makeHome();
    const inHome = join(home, 'in');
    const outHome = join(outside, 'out');
    mkdirSync(inHome);
    mkdirSync(outHome);
    write(join(home, 'real-projects', '-in', 's.jsonl'), claudeLines(inHome), NOW - DAY);
    write(join(outside, 'projects', '-out', 's.jsonl'), claudeLines(outHome), NOW - DAY);
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    symlinkSync(join(home, 'real-projects', '-in'), join(home, '.claude', 'projects', '-in'));
    symlinkSync(join(outside, 'projects', '-out'), join(home, '.claude', 'projects', '-out'));
    symlinkSync(join(home, 'missing'), join(home, '.claude', 'projects', '-dangling'));
    expect(await agentHistoryDirs(deps(home))).toEqual([
      { path: inHome, source: 'claude', lastActivityAt: NOW - DAY },
    ]);
  });

  it('returns nothing when neither CLI has a history directory', async () => {
    const home = makeHome();
    expect(await agentHistoryDirs(deps(home))).toEqual([]);
  });
});

describe('cwdFromHead', () => {
  it('takes the first record with a cwd (top level or payload), skipping records without one', () => {
    expect(cwdFromHead('{"type":"queue-operation"}\n{"cwd":"/a/b","type":"user"}\n')).toBe('/a/b');
    expect(cwdFromHead('{"type":"session_meta","payload":{"cwd":"/c"}}\n')).toBe('/c');
    expect(cwdFromHead('{"cwd":""}\n{"cwd":"/d"}\n')).toBe('/d');
    expect(cwdFromHead('')).toBeNull();
    expect(cwdFromHead('{"type":"x"}\n')).toBeNull();
  });

  it('lifts the field out of a cut record and decodes its escapes', () => {
    expect(cwdFromHead('{"parentUuid":null,"cwd":"C:\\\\Users\\\\me\\\\app","message":"abc')).toBe(
      'C:\\Users\\me\\app',
    );
    expect(cwdFromHead('{"cwd":"/x/y","message":"a\\"b')).toBe('/x/y');
    // A cwd cut mid-string is not a path.
    expect(cwdFromHead('{"parentUuid":null,"cwd":"/x/y')).toBeNull();
  });

  it('cwdFromTail takes the last complete field, ignoring a record cut at the front', () => {
    expect(cwdFromTail('…base64…","cwd":"/first"}\n{"type":"assistant","cwd":"/last","x":1}\n')).toBe(
      '/last',
    );
    expect(cwdFromTail('{"cwd":"/only"}\n{"cwd":"/cut')).toBe('/only');
    expect(cwdFromTail('nothing here')).toBeNull();
  });
});

describe('dayDirEndsAt', () => {
  it('turns sessions/YYYY/MM/DD into the end of that UTC day and rejects other names', () => {
    expect(dayDirEndsAt('2026', '09', '16')).toBe(Date.UTC(2026, 8, 17));
    expect(dayDirEndsAt('2026', '9', '16')).toBeNull();
    expect(dayDirEndsAt('tmp', '09', '16')).toBeNull();
  });
});
