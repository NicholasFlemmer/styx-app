import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { accountLabel, AppServerClient, AppServerError, modelCatalogue } from './app-server-client';

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
