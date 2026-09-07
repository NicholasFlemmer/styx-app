import { copy, fill } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { StreamParser, cloudCliByFullPath } from './stream-runner';

describe('cloudCliByFullPath', () => {
  it.each([
    ['/Users/nic/Downloads/google-cloud-sdk/bin/gcloud run deploy x', 'gcloud'],
    ['cd web && /opt/homebrew/bin/gh pr create', 'gh'],
    ['~/.local/bin/aws s3 ls', 'aws'],
    ['./node_modules/.bin/vercel deploy', 'vercel'],
    ['ssh -i ~/.ssh/key host', null],
    ['gcloud run deploy x', null],
    ['gh auth status && supabase db push', null],
    ['ls /usr/local/bin/gcloud-sdk-notes', null],
    ['cat /Users/nic/.config/gcloud/README', null],
  ])('%s → %s', (command, cli) => {
    expect(cloudCliByFullPath(command)).toBe(cli);
  });
});

describe('StreamParser bypass warning', () => {
  it('a Bash tool_use reaching a cloud CLI by path adds a system line after the tool line; shimmed calls do not', () => {
    const p = new StreamParser('/wt');
    const event = (command: string) => ({
      type: 'assistant',
      message: {
        id: 'm1',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }],
      },
    });
    const bypass = p.parseEvent(event('/Users/nic/sdk/bin/gcloud run deploy api'));
    const systems = bypass.filter((e) => e.type === 'transcript' && e.payload.kind === 'system');
    expect(systems).toHaveLength(1);
    expect(systems[0]?.type === 'transcript' && systems[0].body).toBe(
      fill(copy.chat.controls.bypassWarning, { cli: 'gcloud' }),
    );
    const shimmed = p.parseEvent(event('gcloud run deploy api'));
    expect(shimmed.some((e) => e.type === 'transcript' && e.payload.kind === 'system')).toBe(false);
  });
});
