import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  accountLabel,
  AppServerClient,
  AppServerError,
  codexLimits,
  modelCatalogue,
  windowLabel,
} from './app-server-client';

const lines = (stream: PassThrough): string[] => {
  const out: string[] = [];
  stream.setEncoding('utf8');
  stream.on('data', (c: string) =>
    out.push(
      ...String(c)
        .split('\n')
        .filter((l) => l !== ''),
    ),
  );
  return out;
};

describe('AppServerClient', () => {
  it('numbers requests, resolves by id, rejects on error, and routes notifications / server requests / text', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written = lines(stdin);
    const onNotification = vi.fn();
    const onRequest = vi.fn();
    const onText = vi.fn();
    const client = new AppServerClient(stdin, stdout, { onNotification, onRequest, onText });

    const a = client.request('initialize', { x: 1 });
    const b = client.request('thread/start');
    client.notify('initialized');
    await new Promise((r) => setImmediate(r));
    expect(written.map((l) => JSON.parse(l) as unknown)).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { x: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'thread/start' },
      { jsonrpc: '2.0', method: 'initialized' },
    ]);

    // Answers may interleave and arrive in one chunk or split across chunks.
    stdout.write('{"id":2,"error":{"code":-32000,"mess');
    stdout.write('age":"nope"}}\n{"id":1,"result":{"ok":true}}\nnot json\n');
    stdout.write(
      '{"method":"turn/started","params":{"a":1}}\n{"id":9,"method":"item/tool/call","params":{}}\n',
    );
    await expect(a).resolves.toEqual({ ok: true });
    await expect(b).rejects.toBeInstanceOf(AppServerError);
    await expect(b).rejects.toMatchObject({ method: 'thread/start', code: -32000, message: 'nope' });
    expect(onNotification).toHaveBeenCalledWith('turn/started', { a: 1 });
    expect(onRequest).toHaveBeenCalledWith(9, 'item/tool/call', {});
    expect(onText).toHaveBeenCalledWith('not json');

    client.respond(9, { done: 1 });
    client.respondError(10, -32601, 'no');
    await new Promise((r) => setImmediate(r));
    expect(written.slice(3).map((l) => JSON.parse(l) as unknown)).toEqual([
      { jsonrpc: '2.0', id: 9, result: { done: 1 } },
      { jsonrpc: '2.0', id: 10, error: { code: -32601, message: 'no' } },
    ]);

    // Closing fails what is still pending and refuses new requests; unknown ids and non-objects are ignored.
    const c = client.request('model/list');
    stdout.write('{"id":77,"result":1}\n[1,2]\n');
    client.close('gone');
    await expect(c).rejects.toMatchObject({ message: 'gone' });
    await expect(client.request('x')).rejects.toMatchObject({ message: 'app-server closed' });
  });
});

describe('modelCatalogue', () => {
  it('maps Model → ModelInfo, keeping only efforts Styx knows; garbage → empty', () => {
    expect(
      modelCatalogue({
        data: [
          {
            id: 'gpt-5.5',
            displayName: 'GPT-5.5',
            description: 'Solid',
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'xhigh' },
              { reasoningEffort: 'minimal' },
            ],
            defaultReasoningEffort: 'xhigh',
            isDefault: false,
          },
          { id: 'bare' },
        ],
      }),
    ).toEqual([
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        description: 'Solid',
        efforts: ['low', 'xhigh'],
        defaultEffort: 'xhigh',
        isDefault: false,
        hidden: false,
      },
      {
        id: 'bare',
        label: 'bare',
        description: null,
        efforts: [],
        defaultEffort: null,
        isDefault: false,
        hidden: false,
      },
    ]);
    expect(modelCatalogue({ data: 'x' })).toEqual([]);
    expect(modelCatalogue(null)).toEqual([]);
  });
});

describe('accountLabel', () => {
  it.each([
    [
      { account: { type: 'chatgpt', email: 'nic@acme.dev', planType: 'team' } },
      { signedIn: true, account: 'nic@acme.dev · team' },
    ],
    [
      { account: { type: 'chatgpt', email: null, planType: 'plus' } },
      { signedIn: true, account: 'ChatGPT · plus' },
    ],
    [{ account: { type: 'chatgpt', email: 'x@y.z', planType: null } }, { signedIn: true, account: 'x@y.z' }],
    [{ account: { type: 'apiKey' } }, { signedIn: true, account: 'API key' }],
    [
      { account: { type: 'amazonBedrock', usesCodexManagedCredentials: true } },
      { signedIn: true, account: null },
    ],
    [{ account: null }, { signedIn: false, account: null }],
    [{}, { signedIn: false, account: null }],
    ['nope', { signedIn: false, account: null }],
  ])('%j', (input, expected) => {
    expect(accountLabel(input)).toEqual(expected);
  });
});

describe('codexLimits', () => {
  const NOW = 1_789_600_000_000;
  it.each<[unknown, ReturnType<typeof codexLimits>]>([
    [
      {
        rateLimits: {
          primary: { usedPercent: 85.4, windowDurationMins: 300, resetsAt: 1789561758 },
          secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1790077939 },
          planType: 'team',
        },
      },
      {
        agent: 'codex',
        plan: 'team',
        windows: [
          { label: '5 h', usedPercent: 85.4, resetsAt: 1789561758000 },
          { label: '7 d', usedPercent: 12, resetsAt: 1790077939000 },
        ],
        updatedAt: NOW,
      },
    ],
    // One window, no plan, a reset already in milliseconds, a percentage over 100, a 90-minute window.
    [
      {
        rateLimits: {
          primary: null,
          secondary: { usedPercent: 140, windowDurationMins: 90, resetsAt: 1789561758000 },
        },
      },
      {
        agent: 'codex',
        plan: null,
        windows: [{ label: '90 min', usedPercent: 100, resetsAt: 1789561758000 }],
        updatedAt: NOW,
      },
    ],
    // No duration: labelled by position; no reset: null; empty plan: none.
    [
      { rateLimits: { primary: { usedPercent: 3 }, secondary: undefined, planType: '' } },
      {
        agent: 'codex',
        plan: null,
        windows: [{ label: 'primary', usedPercent: 3, resetsAt: null }],
        updatedAt: NOW,
      },
    ],
    [{ rateLimits: { primary: null, secondary: null } }, null],
    [{ rateLimits: {} }, null],
    [{}, null],
    ['nope', null],
  ])('%j', (input, expected) => {
    expect(codexLimits(input, NOW)).toEqual(expected);
  });

  it('labels windows by days, hours or minutes', () => {
    expect([10080, 1440, 300, 60, 90, 1, null, undefined].map(windowLabel)).toEqual([
      '7 d',
      '1 d',
      '5 h',
      '1 h',
      '90 min',
      '1 min',
      '',
      '',
    ]);
  });
});
