import { describe, expect, it, vi } from 'vitest';
import { FeedbackService } from './feedback-service';

/** Feedback (#123): the message, the email only if given, version / OS / install id, the token when signed in. */
const setup = (
  over: { token?: string | null; respond?: () => Promise<Response>; log?: string | null } = {},
) => {
  const sent: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      auth: new Headers(init?.headers ?? {}).get('Authorization'),
    });
    return over.respond ? over.respond() : new Response('{"ok":true}');
  }) as unknown as typeof globalThis.fetch;
  const service = new FeedbackService({
    fetch: fetchImpl,
    apiBase: () => 'https://api.test/',
    token: async () => (over.token === undefined ? null : over.token),
    installId: () => 'inst_abcdefghijklmnopqrstuv',
    version: '0.2.7',
    os: 'darwin',
    diagnostics: async () => (over.log === undefined ? 'line 1\nline 2' : over.log),
  });
  return { service, sent };
};

describe('FeedbackService', () => {
  it('sends exactly the message, the email, version, OS and install id — and nothing else', async () => {
    const t = setup();
    await t.service.send('Love it', 'me@example.com');
    expect(t.sent[0]?.url).toBe('https://api.test/v1/feedback');
    expect(t.sent[0]?.auth).toBeNull();
    expect(t.sent[0]?.body).toEqual({
      message: 'Love it',
      email: 'me@example.com',
      installId: 'inst_abcdefghijklmnopqrstuv',
      version: '0.2.7',
      os: 'darwin',
    });
  });

  it('attaches the log only when the person ticked diagnostics (#125), and never an empty one', async () => {
    const t = setup();
    await t.service.send('Broken', null);
    expect('diagnostics' in (t.sent[0]?.body ?? {})).toBe(false);
    await t.service.send('Broken', null, true);
    expect(t.sent[1]?.body['diagnostics']).toBe('line 1\nline 2');
    const none = setup({ log: null });
    await none.service.send('Broken', null, true);
    expect('diagnostics' in (none.sent[0]?.body ?? {})).toBe(false);
  });

  it('leaves the email out when none was typed, and adds the token when signed in', async () => {
    const t = setup({ token: 'at-1' });
    await t.service.send('Hi', null);
    expect(t.sent[0]?.auth).toBe('Bearer at-1');
    expect('email' in (t.sent[0]?.body ?? {})).toBe(false);
  });

  it('says why when it could not send: offline, too many, or the server refused', async () => {
    await expect(
      setup({
        respond: async () => {
          throw new Error('ENOTFOUND');
        },
      }).service.send('x', null),
    ).rejects.toThrow('Styx could not reach its server; check your connection');
    await expect(
      setup({ respond: async () => new Response('', { status: 429 }) }).service.send('x', null),
    ).rejects.toThrow('too many messages in a short time; wait a little');
    await expect(
      setup({ respond: async () => new Response('', { status: 500 }) }).service.send('x', null),
    ).rejects.toThrow('the server answered 500');
  });
});

describe('redactedTail (#125)', () => {
  it('keeps the end, starts on a whole line, and masks secrets again', async () => {
    const { redactedTail } = await import('./logger');
    const log = ['old line', 'GH_TOKEN=ghp_' + 'a'.repeat(36), 'last line'].join('\n');
    const tail = redactedTail(log, 60);
    expect(tail.startsWith('GH_TOKEN=') || tail.startsWith('last line')).toBe(true);
    expect(tail).not.toContain('old line');
    expect(tail).not.toContain('a'.repeat(36));
    expect(tail.endsWith('last line')).toBe(true);
    expect(redactedTail('short')).toBe('short');
  });
});
