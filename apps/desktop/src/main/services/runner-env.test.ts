import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpRunner } from './acp-runner';
import { AppServerRunner } from './app-server-runner';
import { StreamRunner, type StreamSpawnOptions } from './stream-runner';

/**
 * Agents never inherit provider tokens from Styx's own environment (a shell profile's GH_TOKEN, VERCEL_TOKEN …): their
 * access to targets goes through grants. Their own credentials (ANTHROPIC_API_KEY …) do pass through. Checked for
 * every runner that spawns an agent CLI, with the env captured at spawn time.
 */
const fakeProcess = () => {
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  return proc;
};

const spawnOptions: StreamSpawnOptions = {
  id: 'sess-env',
  command: 'agent-cli',
  args: [],
  cwd: '/tmp',
  env: { STYX_SESSION_ID: 'sess-env' },
  input: { kind: 'stdin' },
  worktreePath: '/tmp',
  firstMessage: null,
};

const SET = {
  GH_TOKEN: 'ghp_FIXTURE_from_the_shell',
  VERCEL_TOKEN: 'FIXTURE_vercel',
  AWS_SECRET_ACCESS_KEY: 'FIXTURE_aws',
  ANTHROPIC_API_KEY: 'sk-ant-FIXTURE',
};

describe('agent runners strip provider tokens from the inherited environment', () => {
  const before: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const runners = [
    ['StreamRunner (Claude Code)', (spawn: never) => new StreamRunner(spawn)],
    ['AppServerRunner (Codex)', (spawn: never) => new AppServerRunner(spawn)],
    ['AcpRunner (Gemini, Cursor)', (spawn: never) => new AcpRunner(spawn, '0.0.0-test')],
  ] as const;

  it.each(runners)('%s', async (_name, make) => {
    for (const [k, v] of Object.entries(SET)) {
      before[k] = process.env[k];
      process.env[k] = v;
    }
    let env: Record<string, string> | null = null;
    const spawn = ((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
      env = opts.env;
      return fakeProcess();
    }) as never;
    const runner = make(spawn);
    void runner.spawn(spawnOptions).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    const seen = env as Record<string, string> | null;
    expect(seen).not.toBeNull();
    expect(seen?.['GH_TOKEN']).toBeUndefined();
    expect(seen?.['VERCEL_TOKEN']).toBeUndefined();
    expect(seen?.['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(seen?.['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(seen?.['ANTHROPIC_API_KEY']).toBe('sk-ant-FIXTURE');
    expect(seen?.['STYX_SESSION_ID']).toBe('sess-env');
  });
});
