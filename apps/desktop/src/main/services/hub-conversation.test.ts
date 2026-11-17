import type { TranscriptMessage } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { conversationPage, textToHtml, turnsOf } from './hub-conversation';

const msg = (id: string, kind: 'user' | 'agent' | 'tool' | 'system', body: string): TranscriptMessage =>
  ({
    id,
    sessionId: 'ses_1',
    seq: 0,
    body,
    payload:
      kind === 'tool'
        ? { kind: 'tool', tool: 'Bash', hint: 'ls', toolUseId: null, status: 'ok', detail: null }
        : kind === 'system'
          ? { kind: 'system' }
          : { kind },
    askId: null,
    createdAt: 1,
  }) as TranscriptMessage;

const LANE = [
  msg('m1', 'user', 'Why are payments failing?'),
  msg('m2', 'tool', 'ran ls'),
  msg('m3', 'agent', 'The webhook reads `order.id` as a number.'),
  msg('m4', 'system', 'Styx note'),
  msg('m5', 'user', 'Fix it'),
  msg('m6', 'agent', 'Done.'),
];

describe('a conversation shared as a page', () => {
  it('keeps what people and the agent said, not tool steps or system notes', () => {
    expect(turnsOf(LANE, 'Nic', 'Claude', null).map((t) => t.text)).toEqual([
      'Why are payments failing?',
      'The webhook reads `order.id` as a number.',
      'Fix it',
      'Done.',
    ]);
  });

  it('one answer comes with the question just before it, the answer highlighted', () => {
    const t = turnsOf(LANE, 'Nic', 'Claude', 'm3');
    expect(t.map((x) => [x.text, x.highlight, x.agent])).toEqual([
      ['Why are payments failing?', false, null],
      ['The webhook reads `order.id` as a number.', true, 'Claude'],
    ]);
    expect(turnsOf(LANE, 'Nic', 'Claude', 'nope')).toEqual([]);
    // Any message: one of the person's on its own, or one the agent sent mid-turn.
    expect(turnsOf(LANE, 'Nic', 'Claude', 'm5').map((x) => [x.text, x.highlight])).toEqual([['Fix it', true]]);
  });

  it('takes secrets out before anything is shared', () => {
    const t = turnsOf(
      [msg('a', 'agent', 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 here')],
      'Nic',
      'Claude',
      null,
    );
    expect(t[0]?.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('escapes everything, keeps code blocks and inline code', () => {
    const html = textToHtml('<script>alert(1)</script>\n\n```ts\nconst a = "<b>";\n```\nuse `x<y` here');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<pre>const a = &quot;&lt;b&gt;&quot;;</pre>');
    expect(html).toContain('<code>x&lt;y</code>');
  });

  it('is one page with no script, the title and names escaped', () => {
    const page = conversationPage({
      title: 'Card form <for> checkout',
      team: 'Launchsite',
      sharedBy: 'Nic',
      project: 'acme-shop',
      when: '16 Nov',
      turns: turnsOf(LANE, 'Nic', 'Claude', null),
    });
    expect(page).not.toMatch(/<script/i);
    expect(page).toContain('<h1>Card form &lt;for&gt; checkout</h1>');
    expect(page).toContain('Launchsite · shared by Nic from Styx · acme-shop · 16 Nov');
    expect(page).toContain('<b>Claude</b> for Nic');
  });
});
