import type { PermissionMode } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { codexLaunch, codexPolicy, codexTrustKey } from './codex';
import type { AgentLaunchContext } from './types';

const WT = '/Users/nic/.styx/worktrees/STYX/agent-codex-1';
const PROJECT = '/Users/nic/STYX';

const ctx = (over: Partial<AgentLaunchContext> = {}): AgentLaunchContext => ({
  agent: 'codex',
  binary: '/opt/codex',
  capabilities: {},
  sessionId: 'sess-1',
  worktreePath: WT,
  projectPath: PROJECT,
  firstMessage: null,
  model: null,
  runner: 'pty',
  autoApproveEdits: false,
  permissionMode: 'default',
  effort: null,
  resumeSessionId: null,
  configDir: '/tmp/cfg',
  shimDir: '/shims',
  platform: 'darwin',
  env: { STYX_SESSION_ID: 'sess-1', STYX_BROKER: '/tmp/b.sock', STYX_TOKEN: 'tok-super-secret' },
  ...over,
});

describe('codexPolicy (docs/research/agent-parity.md §5)', () => {
  const ws = {
    type: 'workspaceWrite',
    writableRoots: [WT],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
  const table: [PermissionMode, unknown][] = [
    [
      'default',
      {
        approvalPolicy: 'on-request',
        sandboxPolicy: ws,
        sandboxMode: 'workspace-write',
        approvalsReviewer: 'user',
      },
    ],
    [
      'acceptEdits',
      {
        approvalPolicy: 'on-request',
        sandboxPolicy: ws,
        sandboxMode: 'workspace-write',
        approvalsReviewer: 'user',
      },
    ],
    [
      'plan',
      {
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        sandboxMode: 'read-only',
        approvalsReviewer: 'user',
      },
    ],
    [
      'bypassPermissions',
      {
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        sandboxMode: 'danger-full-access',
        approvalsReviewer: 'user',
      },
    ],
    [
      'dontAsk',
      {
        approvalPolicy: 'never',
        sandboxPolicy: ws,
        sandboxMode: 'workspace-write',
        approvalsReviewer: 'user',
      },
    ],
    [
      'auto',
      {
        approvalPolicy: 'on-request',
        sandboxPolicy: ws,
        sandboxMode: 'workspace-write',
        approvalsReviewer: 'auto_review',
      },
    ],
  ];
  it.each(table)('%s', (mode, expected) => {
    expect(codexPolicy(mode, [WT])).toEqual(expected);
  });

  it('dedupes the writable roots', () => {
    const p = codexPolicy('default', [WT, WT]);
    expect(p.sandboxPolicy).toMatchObject({ writableRoots: [WT] });
  });
});

describe('codexLaunch', () => {
  it('stream: `codex app-server` with the MCP server (env by name) and trust overrides; no prompt, no notify, no -m', async () => {
    const l = await codexLaunch(
      ctx({ runner: 'stream', firstMessage: 'fix the flaky test', model: 'gpt-6', effort: 'high' }),
    );
    expect(l.command).toBe('/opt/codex');
    expect(l.stream).toEqual({ kind: 'app-server' });
    expect(l.typeFirstMessage).toBe(false);
    expect(l.env).toEqual({});
    expect(l.args[0]).toBe('app-server');
    expect(l.args).toContain('mcp_servers.styx.command="/shims/styx"');
    expect(l.args).toContain('mcp_servers.styx.args=["mcp"]');
    expect(l.args.join(' ')).toContain(
      'mcp_servers.styx.env_vars=["STYX_SESSION_ID","STYX_BROKER","STYX_TOKEN"',
    );
    expect(l.args).toContain(`${codexTrustKey(WT)}="trusted"`);
    expect(l.args).toContain(`${codexTrustKey(PROJECT)}="trusted"`);
    // Model, effort and the first message travel in thread/start and turn/start, never on argv.
    expect(l.args).not.toContain('fix the flaky test');
    expect(l.args).not.toContain('-m');
    expect(l.args.some((a) => a.startsWith('notify='))).toBe(false);
    // The token is forwarded by name, never spelled out on the command line.
    expect(l.args.join(' ')).not.toContain('tok-super-secret');
    // Every override is a `-c key=value` pair.
    for (let i = 1; i < l.args.length; i += 2) expect(l.args[i]).toBe('-c');
    await l.cleanup();
  });

  it('pty (older builds): the TUI with the notify hook, trust overrides, model and prompt', async () => {
    const l = await codexLaunch(ctx({ firstMessage: 'hi', model: 'gpt-6' }));
    expect(l.stream).toBeUndefined();
    expect(l.args[0]).toBe('-c');
    expect(l.args).toContain('notify=["/shims/styx","hook","codex"]');
    expect(l.args.slice(-3)).toEqual(['-m', 'gpt-6', 'hi']);
  });
});
