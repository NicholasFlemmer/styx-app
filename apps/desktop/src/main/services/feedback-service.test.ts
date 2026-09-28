import { describe, expect, it, vi } from 'vitest';
import { FeedbackService } from './feedback-service';

/** Feedback (#123): the message, the email only if given, version / OS / install id, the token when signed in. */
const setup = (over: { token?: string | null; respond?: () => Promise<Response> } = {}) => {
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
