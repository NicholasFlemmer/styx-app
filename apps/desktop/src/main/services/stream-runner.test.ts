import { describe, expect, it } from 'vitest';
import {
  chatSlashCommands,
  permissionResponseLine,
  relPath,
  StreamParser,
  StreamRunner,
  toolHint,
  userTurnLine,
  type StreamEffect,
} from './stream-runner';

const WT = '/tmp/wt';

const parseAll = (lines: string[]): StreamEffect[] => {
  const p = new StreamParser(WT);
  return lines.flatMap((l) => p.parseLine(l));
};

/** Claude Code `--output-format stream-json` shapes (2.1.x): system/init, assistant, user(tool_result), result. */
const INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'abc-123',
  model: 'claude-fable-5',
  permissionMode: 'plan',
  cwd: WT,
  tools: ['Edit'],
});
const ASSISTANT_TEXT = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'Read checkout.ts and pay.ts.\nPlan: new validate.ts.' }],
  },
  session_id: 'abc-123',
});
const ASSISTANT_EDIT = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Edit',
        input: { file_path: `${WT}/checkout.ts`, old_string: 'a', new_string: 'b' },
      },
      {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'Write',
        input: { file_path: `${WT}/validate.ts`, content: 'x' },
      },
      { type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'pnpm test\n--filter x' } },
    ],
  },
});
const TOOL_RESULT = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
});
const RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done.',
  duration_ms: 1234,
  num_turns: 3,
  total_cost_usd: 0.0421,
  session_id: 'abc-123',
  usage: { input_tokens: 10, output_tokens: 5 },
});
const RESULT_ERR = JSON.stringify({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  result: 'boom',
});
const CONTROL = JSON.stringify({
  type: 'control_request',
  request_id: 'req-1',
  request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } },
});

describe('StreamParser', () => {
  it('maps system/init to activity and remembers the chat id', () => {
    const p = new StreamParser(WT);
    const fx = p.parseLine(INIT);
    expect(fx).toContainEqual({
      type: 'init',
      chatId: 'abc-123',
      model: 'claude-fable-5',
      permissionMode: 'plan',
      slashCommands: [],
    });
    expect(parseAll([JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' })])[0]).toEqual({
      type: 'init',
      chatId: 'x',
      model: null,
      permissionMode: null,
      slashCommands: [],
    });
    expect(fx).toContainEqual({ type: 'session', event: 'activity' });
    expect(p.chatId).toBe('abc-123');
  });

  it('assistant text → agent transcript message + note + render', () => {
    const fx = parseAll([ASSISTANT_TEXT]);
    expect(fx).toContainEqual({
      type: 'transcript',
      body: 'Read checkout.ts and pay.ts.\nPlan: new validate.ts.',
      payload: { kind: 'agent' },
    });
    expect(fx).toContainEqual({ type: 'note', note: 'Read checkout.ts and pay.ts.' });
    expect(fx.find((f) => f.type === 'render')).toMatchObject({
      text: 'Read checkout.ts and pay.ts.\r\nPlan: new validate.ts.\r\n',
    });
  });

  it('edit tool_use → file-list with worktree-relative paths; matching tool_result → rescan', () => {
    const p = new StreamParser(WT);
    const fx = p.parseLine(ASSISTANT_EDIT);
    expect(fx).toContainEqual({
      type: 'transcript',
      body: 'checkout.ts, validate.ts',
      payload: {
        kind: 'file-list',
        files: [
          { path: 'checkout.ts', added: 0, removed: 0 },
          { path: 'validate.ts', added: 0, removed: 0 },
        ],
      },
    });
    expect(fx.filter((f) => f.type === 'render').map((f) => (f as { text: string }).text)).toEqual([
      '▸ Edit checkout.ts\r\n',
      '▸ Write validate.ts\r\n',
      '▸ Bash pnpm test\r\n',
    ]);
    expect(fx).not.toContainEqual({ type: 'rescan' });
    const after = p.parseLine(TOOL_RESULT);
    expect(after).toContainEqual({ type: 'rescan' });
    expect(after).toContainEqual({ type: 'session', event: 'activity' });
  });

  it('result → usage + quiet (idle); an error result also posts an error', () => {
    expect(parseAll([RESULT])).toEqual([
      { type: 'render', text: '— done in 1.2s\r\n' },
      { type: 'usage', costUsd: 0.0421, numTurns: 3, durationMs: 1234 },
      { type: 'session', event: 'quiet' },
    ]);
    const err = parseAll([RESULT_ERR]);
    expect(err).toContainEqual({ type: 'error', message: 'boom' });
    expect(err).toContainEqual({ type: 'usage', costUsd: null, numTurns: null, durationMs: null });
    expect(err.at(-1)).toEqual({ type: 'session', event: 'quiet' });
  });

  it('edit tool_use also posts a running `tool` transcript line per tool (patched later by its result)', () => {
    const tools = parseAll([ASSISTANT_EDIT]).filter(
      (f): f is Extract<StreamEffect, { type: 'transcript' }> =>
        f.type === 'transcript' && f.payload.kind === 'tool',
    );
    expect(tools.map((t) => [t.body, t.payload])).toEqual([
      ['Edit checkout.ts', { kind: 'tool', tool: 'Edit', hint: 'checkout.ts', toolUseId: 'toolu_1', status: 'running', detail: null }],
      ['Write validate.ts', { kind: 'tool', tool: 'Write', hint: 'validate.ts', toolUseId: 'toolu_2', status: 'running', detail: null }],
      ['Bash pnpm test', { kind: 'tool', tool: 'Bash', hint: 'pnpm test', toolUseId: 'toolu_3', status: 'running', detail: null }],
    ]);
  });

  it.each([
    ['Bash', { command: 'git status\n&& git diff' }, 'git status'],
    ['Read', { file_path: `${WT}/src/a.ts` }, 'src/a.ts'],
    ['NotebookEdit', { notebook_path: `${WT}/nb.ipynb` }, 'nb.ipynb'],
    ['Edit', {}, ''],
    ['Grep', { pattern: 'TODO', path: WT }, 'TODO'],
    ['Glob', { pattern: '**/*.ts' }, '**/*.ts'],
    ['Agent', { description: 'Find callers', prompt: 'long…' }, 'Find callers'],
    ['Task', { prompt: 'Line one\nline two' }, 'Line one'],
    ['WebFetch', { url: 'https://example.com/x', prompt: 'summarise' }, 'https://example.com/x'],
    ['WebSearch', { query: 'zod v4 discriminatedUnion' }, 'zod v4 discriminatedUnion'],
    ['TodoWrite', { todos: [{ content: 'a' }] }, ''],
    ['mcp__styx__request_access', { target: 'x'.repeat(150) }, `${'x'.repeat(99)}…`],
  ])('toolHint(%s, %j) → %j', (name, input, hint) => {
    expect(toolHint(WT, name, input)).toBe(hint);
  });

  it('non-edit tool_use → `tool` transcript line with the hint and a render line; result → toolResult', () => {
    const p = new StreamParser(WT);
    const fx = p.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_g', name: 'Grep', input: { pattern: 'foo', path: WT } },
            { type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: `${WT}/b.ts` } },
          ],
        },
      }),
    );
    expect(fx).toEqual([
      { type: 'session', event: 'activity' },
      { type: 'transcript', body: 'Grep foo', payload: { kind: 'tool', tool: 'Grep', hint: 'foo', toolUseId: 'toolu_g', status: 'running', detail: null } },
      { type: 'render', text: '▸ Grep foo\r\n' },
      { type: 'transcript', body: 'Read b.ts', payload: { kind: 'tool', tool: 'Read', hint: 'b.ts', toolUseId: 'toolu_r', status: 'running', detail: null } },
      { type: 'render', text: '▸ Read b.ts\r\n' },
    ]);
    const ok = p.parseLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_g', content: [{ type: 'text', text: 'a.ts:1' }] }] },
      }),
    );
    expect(ok).toEqual([
      { type: 'session', event: 'activity' },
      { type: 'toolResult', toolUseId: 'toolu_g', ok: true, detail: null },
    ]);
    expect(ok).not.toContainEqual({ type: 'rescan' });
  });

  it.each([
    ['string content', 'ENOENT: no such file\nat read()', 'ENOENT: no such file'],
    ['block content', [{ type: 'text', text: `${'e'.repeat(200)}` }], `${'e'.repeat(159)}…`],
    ['empty content', '', null],
  ])('error tool_result (%s) → toolResult ok:false with a 160-char detail', (_label, content, detail) => {
    const fx = parseAll([
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', is_error: true, content }] },
      }),
    ]);
    expect(fx).toContainEqual({ type: 'toolResult', toolUseId: 'toolu_x', ok: false, detail });
    expect(fx.some((f) => f.type === 'render')).toBe(detail !== null);
  });

  it('system/compact_boundary → system transcript line "context compacted" + render', () => {
    const fx = parseAll([
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 20000 },
      }),
    ]);
    expect(fx).toEqual([
      { type: 'transcript', body: 'context compacted', payload: { kind: 'system' } },
      { type: 'render', text: '· context compacted (auto · 150000 tokens)\r\n' },
    ]);
    expect(parseAll([JSON.stringify({ type: 'system', subtype: 'compact_boundary' })])).toEqual([
      { type: 'transcript', body: 'context compacted', payload: { kind: 'system' } },
      { type: 'render', text: '· context compacted\r\n' },
    ]);
  });

  it.each([
    [
      { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_800_000_000 },
      [{ type: 'render', text: '· rate limit: rejected (five_hour) · resets 2027-01-15T08:00:00.000Z\r\n' }],
    ],
    [{ status: 'allowed_warning' }, [{ type: 'render', text: '· rate limit: allowed_warning\r\n' }]],
    [{ status: 'allowed', rateLimitType: 'five_hour' }, []],
    [undefined, [{ type: 'render', text: '· rate limit: unknown\r\n' }]],
  ])('rate_limit_event %j → render line only', (info, expected) => {
    expect(parseAll([JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info, session_id: 'x' })])).toEqual(
      expected,
    );
  });

  it('result after unresolved edits still rescans', () => {
    const fx = parseAll([ASSISTANT_EDIT, RESULT]);
    expect(fx.filter((f) => f.type === 'rescan')).toHaveLength(1);
  });

  it('control_request can_use_tool → permission effect', () => {
    expect(parseAll([CONTROL])).toContainEqual({
      type: 'permission',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
    });
  });

  it('non-JSON and unknown events: rendered or ignored, never thrown', () => {
    expect(parseAll(['warning: something', '', '   '])).toEqual([
      { type: 'render', text: 'warning: something\r\n' },
    ]);
    expect(
      parseAll([
        JSON.stringify({ type: 'stream_event', event: {} }),
        JSON.stringify({ type: 'control_response' }),
        '[1,2]',
      ]),
    ).toEqual([]);
  });

  it('relPath keeps paths outside the worktree absolute', () => {
    expect(relPath(WT, `${WT}/src/a.ts`)).toBe('src/a.ts');
    expect(relPath(WT, 'src/a.ts')).toBe('src/a.ts');
    expect(relPath(WT, '/etc/hosts')).toBe('/etc/hosts');
  });

  it.each([
    ['claude 2.1.263 init: terminal-only commands are dropped, the rest sorted',
      ['compact', 'model', 'doctor', 'context', 'my-skill', 'color'],
      ['doctor', 'color', 'reload-plugins'],
      ['compact', 'context', 'model', 'my-skill']],
    ['duplicates collapse', ['b', 'a', 'b', 'a'], [], ['a', 'b']],
    ['absent lists → empty', undefined, undefined, []],
    ['non-string entries are ignored', ['ok', 1, null, ''], 'not-a-list', ['ok']],
  ] as const)('init slash commands: %s', (_label, all, terminal, expected) => {
    expect(chatSlashCommands(all, terminal)).toEqual(expected);
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'x',
      ...(all !== undefined ? { slash_commands: all } : {}),
      ...(terminal !== undefined ? { terminal_slash_commands: terminal } : {}),
    });
    expect(parseAll([line])[0]).toMatchObject({ type: 'init', slashCommands: expected });
  });

  it('stdin lines are single-line JSON', () => {
    expect(JSON.parse(userTurnLine('hi\nthere'))).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi\nthere' }] },
    });
    expect(userTurnLine('x').endsWith('\n')).toBe(true);
    // image blocks go before the text block (Messages API user content)
    const img = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' } };
    expect(JSON.parse(userTurnLine('what is this?', [img]))).toEqual({
      type: 'user',
      message: { role: 'user', content: [img, { type: 'text', text: 'what is this?' }] },
    });
    expect(userTurnLine('a', [img]).split('\n')).toHaveLength(2);
    expect(JSON.parse(permissionResponseLine('r1', true, { a: 1 }))).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'r1',
        response: { behavior: 'allow', updatedInput: { a: 1 } },
      },
    });
    expect(JSON.parse(permissionResponseLine('r1', false, {}, 'no'))).toMatchObject({
      response: { response: { behavior: 'deny', message: 'no' } },
    });
  });
});

/** A stand-in for `claude -p --input-format stream-json --output-format stream-json`: NDJSON both ways over pipes. */
const FAKE_CLI = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'fake' });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'user') {
    const blocks = m.message.content;
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const images = blocks.filter((b) => b.type === 'image' && b.source.type === 'base64').length;
    const tag = images ? ' +' + images + 'img' : '';
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ' + text + tag }] } });
    if (text === 'danger') out({ type: 'control_request', request_id: 'req-9', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm' } } });
    else out({ type: 'result', subtype: 'success', is_error: false, result: 'echo: ' + text, duration_ms: 5 });
  } else if (m.type === 'control_response') {
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ctl:' + JSON.stringify(m.response.response) }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1 });
  }
});
rl.on('close', () => process.exit(0));
`;

/**
 * `--include-partial-messages` (claude 2.1.263): `{type:'stream_event', event, session_id, parent_tool_use_id}` lines
 * wrapping Messages API streaming events, followed by the complete `assistant` event with the same blocks.
 */
const se = (event: Record<string, unknown>, parent: string | null = null): string =>
  JSON.stringify({ type: 'stream_event', event, session_id: 'abc-123', parent_tool_use_id: parent });
const msgStart = (id: string | null = 'msg_1', parent: string | null = null): string =>
  se({ type: 'message_start', message: { ...(id ? { id } : {}), role: 'assistant', content: [] } }, parent);
const blockStart = (index: number, type: string, initial = '', parent: string | null = null): string =>
  se(
    {
      type: 'content_block_start',
      index,
      content_block:
        type === 'text'
          ? { type, text: initial }
          : type === 'thinking'
            ? { type, thinking: initial, signature: '' }
            : type === 'redacted_thinking'
              ? { type, data: 'xxx' }
              : { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: {} },
    },
    parent,
  );
const textDelta = (index: number, text: string, parent: string | null = null): string =>
  se({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, parent);
const thinkDelta = (index: number, thinking: string): string =>
  se({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
const sigDelta = (index: number): string =>
  se({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } });
const jsonDelta = (index: number): string =>
  se({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"co' } });
const blockStop = (index: number, parent: string | null = null): string =>
  se({ type: 'content_block_stop', index }, parent);
const MSG_DELTA = se({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } });
const MSG_STOP = se({ type: 'message_stop' });
const final = (content: unknown[], id: string | null = 'msg_1', parent: string | null = null): string =>
  JSON.stringify({
    type: 'assistant',
    message: { ...(id ? { id } : {}), role: 'assistant', content },
    session_id: 'abc-123',
    parent_tool_use_id: parent,
  });
const ACTIVITY: StreamEffect = { type: 'session', event: 'activity' };

describe('StreamParser partial messages (--include-partial-messages)', () => {
  it('streams a thinking block then a text block live, and the complete assistant event reconciles both', () => {
    const p = new StreamParser(WT);
    const fx = (line: string) => p.parseLine(line);
    expect(fx(msgStart())).toEqual([]);
    expect(fx(blockStart(0, 'thinking'))).toEqual([{ type: 'streamStart', key: 'msg_1:0', kind: 'thinking' }]);
    expect(fx(thinkDelta(0, 'Let me '))).toEqual([{ type: 'streamDelta', key: 'msg_1:0', text: 'Let me ' }]);
    expect(fx(thinkDelta(0, 'think'))).toEqual([{ type: 'streamDelta', key: 'msg_1:0', text: 'think' }]);
    expect(fx(sigDelta(0))).toEqual([]);
    expect(fx(blockStop(0))).toEqual([{ type: 'streamStop', key: 'msg_1:0' }]);
    expect(fx(blockStart(1, 'text'))).toEqual([{ type: 'streamStart', key: 'msg_1:1', kind: 'text' }]);
    expect(fx(textDelta(1, 'Hel'))).toEqual([{ type: 'streamDelta', key: 'msg_1:1', text: 'Hel' }]);
    expect(fx(textDelta(1, 'lo '))).toEqual([{ type: 'streamDelta', key: 'msg_1:1', text: 'lo ' }]);
    expect(fx(blockStop(1))).toEqual([{ type: 'streamStop', key: 'msg_1:1' }]);
    expect(fx(MSG_DELTA)).toEqual([{ type: 'streamUsage', outputTokens: 42 }]);
    expect(fx(MSG_STOP)).toEqual([]);
    // The complete message: no new transcript rows, the final bodies reconcile the live rows; note + render as before.
    expect(
      fx(
        final([
          { type: 'thinking', thinking: 'Let me think', signature: 'sig' },
          { type: 'text', text: 'Hello ' },
        ]),
      ),
    ).toEqual([
      ACTIVITY,
      { type: 'streamFinal', key: 'msg_1:0', body: 'Let me think' },
      { type: 'streamFinal', key: 'msg_1:1', body: 'Hello' },
      { type: 'note', note: 'Hello' },
      { type: 'render', text: 'Hello\r\n' },
    ]);
  });

  it('tool_use blocks in a streamed message still become tool lines; their input deltas are ignored', () => {
    const p = new StreamParser(WT);
    const lines = [msgStart(), blockStart(0, 'text'), textDelta(0, 'Running'), blockStop(0), blockStart(1, 'tool_use')];
    const fx = lines.flatMap((l) => p.parseLine(l));
    expect(fx.filter((f) => f.type === 'streamStart')).toHaveLength(1);
    expect(p.parseLine(jsonDelta(1))).toEqual([]);
    expect(p.parseLine(blockStop(1))).toEqual([]);
    expect(p.parseLine(MSG_STOP)).toEqual([]);
    const done = p.parseLine(
      final([
        { type: 'text', text: 'Running' },
        { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'pnpm test' } },
      ]),
    );
    expect(done).toEqual([
      ACTIVITY,
      { type: 'streamFinal', key: 'msg_1:0', body: 'Running' },
      {
        type: 'transcript',
        body: 'Bash pnpm test',
        payload: { kind: 'tool', tool: 'Bash', hint: 'pnpm test', toolUseId: 'toolu_9', status: 'running', detail: null },
      },
      { type: 'render', text: '▸ Bash pnpm test\r\n' },
      { type: 'note', note: 'Running' },
      { type: 'render', text: 'Running\r\n' },
    ]);
  });

  it('the CLI may split one message into one assistant event per block: keys are consumed per kind in order', () => {
    const p = new StreamParser(WT);
    for (const l of [
      msgStart(),
      blockStart(0, 'thinking'),
      blockStop(0),
      blockStart(1, 'text'),
      blockStop(1),
      blockStart(2, 'text'),
      blockStop(2),
      MSG_STOP,
    ])
      p.parseLine(l);
    expect(p.parseLine(final([{ type: 'thinking', thinking: 'hmm', signature: 's' }]))).toEqual([
      ACTIVITY,
      { type: 'streamFinal', key: 'msg_1:0', body: 'hmm' },
    ]);
    expect(p.parseLine(final([{ type: 'text', text: 'one' }]))).toEqual([
      ACTIVITY,
      { type: 'streamFinal', key: 'msg_1:1', body: 'one' },
      { type: 'note', note: 'one' },
      { type: 'render', text: 'one\r\n' },
    ]);
    expect(p.parseLine(final([{ type: 'text', text: 'two' }]))).toContainEqual({
      type: 'streamFinal',
      key: 'msg_1:2',
      body: 'two',
    });
    // A fourth text block that never streamed (keys exhausted) is a plain transcript row.
    expect(p.parseLine(final([{ type: 'text', text: 'three' }]))).toContainEqual({
      type: 'transcript',
      body: 'three',
      payload: { kind: 'agent' },
    });
  });

  it('thinking that was not streamed (partials off) lands as a done thinking row before the text', () => {
    expect(
      parseAll([
        final([
          { type: 'thinking', thinking: 'Consider the tests.', signature: 's' },
          { type: 'text', text: 'Adding tests.' },
        ]),
      ]),
    ).toEqual([
      ACTIVITY,
      {
        type: 'transcript',
        body: 'Consider the tests.',
        payload: { kind: 'thinking', status: 'done', durationMs: null },
      },
      { type: 'transcript', body: 'Adding tests.', payload: { kind: 'agent' } },
      { type: 'note', note: 'Adding tests.' },
      { type: 'render', text: 'Adding tests.\r\n' },
    ]);
  });

  it.each<[string, string[], StreamEffect[]]>([
    [
      'a delta with no message / block open',
      [textDelta(0, 'partial')],
      [],
    ],
    [
      'a delta for an index that never started',
      [msgStart(), blockStart(0, 'text'), textDelta(3, 'x')],
      [{ type: 'streamStart', key: 'msg_1:0', kind: 'text' }],
    ],
    [
      'a stop for an index that never started',
      [msgStart(), blockStop(4)],
      [],
    ],
    [
      'redacted_thinking and tool_use blocks',
      [msgStart(), blockStart(0, 'redacted_thinking'), blockStart(1, 'tool_use'), blockStop(0), blockStop(1)],
      [],
    ],
    [
      'subagent output (parent_tool_use_id set)',
      [msgStart('msg_sub', 'toolu_task'), blockStart(0, 'text', '', 'toolu_task'), textDelta(0, 'sub', 'toolu_task'), blockStop(0, 'toolu_task')],
      [],
    ],
    [
      'message_delta without usage, unknown event types, a malformed event',
      [
        msgStart(),
        se({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
        se({ type: 'ping' }),
        JSON.stringify({ type: 'stream_event', event: 'nope' }),
      ],
      [],
    ],
  ])('ignores %s', (_name, lines, expected) => {
    expect(parseAll(lines)).toEqual(expected);
  });

  it("a subagent's complete assistant event is a plain transcript row, never a streamFinal", () => {
    const p = new StreamParser(WT);
    for (const l of [msgStart(), blockStart(0, 'text'), textDelta(0, 'parent'), blockStop(0)]) p.parseLine(l);
    expect(p.parseLine(final([{ type: 'text', text: 'from the subagent' }], 'msg_sub', 'toolu_task'))).toEqual([
      ACTIVITY,
      { type: 'transcript', body: 'from the subagent', payload: { kind: 'agent' } },
      { type: 'note', note: 'from the subagent' },
      { type: 'render', text: 'from the subagent\r\n' },
    ]);
    // An id-less subagent event does not fall back to the parent's streamed message either.
    expect(p.parseLine(final([{ type: 'text', text: 'again' }], null, 'toolu_task'))).toContainEqual({
      type: 'transcript',
      body: 'again',
      payload: { kind: 'agent' },
    });
    expect(p.parseLine(final([{ type: 'text', text: 'parent' }]))).toContainEqual({
      type: 'streamFinal',
      key: 'msg_1:0',
      body: 'parent',
    });
  });

  it('falls back to a counter when message_start carries no id, and an id-less final uses the current message', () => {
    const p = new StreamParser(WT);
    expect([msgStart(null), blockStart(0, 'text')].flatMap((l) => p.parseLine(l))).toEqual([
      { type: 'streamStart', key: 'msg-1:0', kind: 'text' },
    ]);
    p.parseLine(blockStop(0));
    expect(p.parseLine(final([{ type: 'text', text: 'a' }], null))).toContainEqual({
      type: 'streamFinal',
      key: 'msg-1:0',
      body: 'a',
    });
    // A block without any message_start opens a message of its own; a later block joins the current message.
    const q = new StreamParser(WT);
    expect(q.parseLine(blockStart(0, 'text'))).toEqual([{ type: 'streamStart', key: 'msg-1:0', kind: 'text' }]);
    expect(q.parseLine(blockStart(1, 'text'))).toEqual([{ type: 'streamStart', key: 'msg-1:1', kind: 'text' }]);
  });

  it('a final assistant event whose id was never streamed is a plain transcript row', () => {
    const p = new StreamParser(WT);
    for (const l of [msgStart(), blockStart(0, 'text'), textDelta(0, 'x'), blockStop(0)]) p.parseLine(l);
    expect(p.parseLine(final([{ type: 'text', text: 'other' }], 'msg_other'))).toContainEqual({
      type: 'transcript',
      body: 'other',
      payload: { kind: 'agent' },
    });
  });

  it('a block that starts with text already in it treats that text as its first delta', () => {
    expect(parseAll([msgStart(), blockStart(0, 'text', 'Hi')])).toEqual([
      { type: 'streamStart', key: 'msg_1:0', kind: 'text' },
      { type: 'streamDelta', key: 'msg_1:0', text: 'Hi' },
    ]);
  });

  it('message_stop and result stop straggling blocks; result forgets the streamed message', () => {
    const p = new StreamParser(WT);
    for (const l of [msgStart(), blockStart(0, 'text'), textDelta(0, 'a')]) p.parseLine(l);
    expect(p.parseLine(MSG_STOP)).toEqual([{ type: 'streamStop', key: 'msg_1:0' }]);
    expect(p.parseLine(blockStop(0))).toEqual([]); // already stopped
    p.parseLine(msgStart('msg_2'));
    p.parseLine(blockStart(0, 'thinking'));
    const res = p.parseLine(RESULT);
    expect(res).toContainEqual({ type: 'streamStop', key: 'msg_2:0' });
    expect(res.indexOf(res.find((f) => f.type === 'streamStop')!)).toBeLessThan(
      res.indexOf(res.find((f) => f.type === 'session')!),
    );
    // After the result the ids are gone: a late final for msg_1 is a plain row.
    expect(p.parseLine(final([{ type: 'text', text: 'late' }]))).toContainEqual({
      type: 'transcript',
      body: 'late',
      payload: { kind: 'agent' },
    });
  });

  it('the observed claude 2.1.263 order: each block\'s complete assistant event precedes its content_block_stop', () => {
    // Recorded with `claude -p --output-format stream-json --verbose --include-partial-messages` (haiku, thinking on).
    const p = new StreamParser(WT);
    const fx = (line: string) => p.parseLine(line);
    expect(fx(msgStart('msg_011'))).toEqual([]);
    expect(fx(blockStart(0, 'thinking'))).toEqual([{ type: 'streamStart', key: 'msg_011:0', kind: 'thinking' }]);
    expect(fx(thinkDelta(0, ''))).toEqual([]); // an empty thinking delta carries nothing
    expect(fx(sigDelta(0))).toEqual([]);
    expect(fx(final([{ type: 'thinking', thinking: '', signature: 'sig' }], 'msg_011'))).toEqual([
      ACTIVITY,
      { type: 'streamFinal', key: 'msg_011:0', body: '' },
    ]);
    expect(fx(blockStop(0))).toEqual([{ type: 'streamStop', key: 'msg_011:0' }]);
    expect(fx(blockStart(1, 'text'))).toEqual([{ type: 'streamStart', key: 'msg_011:1', kind: 'text' }]);
    expect(fx(textDelta(1, 'hello there'))).toEqual([{ type: 'streamDelta', key: 'msg_011:1', text: 'hello there' }]);
    expect(fx(final([{ type: 'text', text: 'hello there' }], 'msg_011'))).toEqual([
      ACTIVITY,
      { type: 'streamFinal', key: 'msg_011:1', body: 'hello there' },
      { type: 'note', note: 'hello there' },
      { type: 'render', text: 'hello there\r\n' },
    ]);
    expect(fx(blockStop(1))).toEqual([{ type: 'streamStop', key: 'msg_011:1' }]);
    expect(fx(MSG_DELTA)).toEqual([{ type: 'streamUsage', outputTokens: 42 }]);
    expect(fx(MSG_STOP)).toEqual([]);
    expect(fx(RESULT).filter((f) => f.type === 'streamStop')).toEqual([]);
  });

  it('an empty final text block still reconciles (to "") but adds no note or render', () => {
    const p = new StreamParser(WT);
    for (const l of [msgStart(), blockStart(0, 'text'), blockStop(0), MSG_STOP]) p.parseLine(l);
    expect(p.parseLine(final([{ type: 'text', text: ' \n' }]))).toEqual([
      ACTIVITY,
      { type: 'streamFinal', key: 'msg_1:0', body: '' },
    ]);
  });
});

describe('StreamRunner (child_process pipes)', () => {
  it('round-trips NDJSON: first message, a second turn, a permission reply, then exit on kill', async () => {
    const runner = new StreamRunner();
    const effects: StreamEffect[] = [];
    runner.on('effect', (_id, e) => effects.push(e));
    const exited = new Promise<number | null>((resolve) => runner.on('exit', (_id, code) => resolve(code)));
    const until = (pred: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const tick = () =>
          pred() ? resolve() : Date.now() - t0 > 5000 ? reject(new Error('timeout')) : setTimeout(tick, 10);
        tick();
      });
    const { pid } = await runner.spawn({
      id: 's1',
      command: process.execPath,
      args: ['-e', FAKE_CLI],
      cwd: process.cwd(),
      env: {},
      input: { kind: 'stdin' },
      worktreePath: WT,
      firstMessage: 'hello',
    });
    expect(pid).toBeGreaterThan(0);
    expect(runner.has('s1')).toBe(true);
    await until(() => effects.some((e) => e.type === 'transcript' && e.body === 'echo: hello'));
    // the `result` line may land in a later stdout chunk than the assistant line
    await until(() => effects.filter((e) => e.type === 'session' && e.event === 'quiet').length === 1);

    runner.send('s1', 'danger');
    await until(() => effects.some((e) => e.type === 'permission'));
    runner.respondPermission('s1', 'req-9', true, undefined, { answers: { q: 'a' } });
    await until(() => effects.filter((x) => x.type === 'session' && x.event === 'quiet').length === 2);
    // the CLI echoed our control_response back: the updatedInput override (not the stored input) went down stdin
    const ctl = () => effects.filter((e) => e.type === 'transcript' && e.body.startsWith('ctl:')).map((e) => (e as { body: string }).body);
    expect(ctl().at(-1)).toBe('ctl:{"behavior":"allow","updatedInput":{"answers":{"q":"a"}}}');
    runner.send('s1', 'danger');
    await until(() => effects.filter((e) => e.type === 'permission').length === 2);
    runner.respondPermission('s1', 'req-9', false, 'nope');
    await until(() => ctl().length === 2);
    expect(ctl().at(-1)).toBe('ctl:{"behavior":"deny","message":"nope"}');

    // image blocks travel down stdin ahead of the text (the fake CLI counts base64 image blocks)
    runner.send('s1', 'look', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
    await until(() => effects.some((e) => e.type === 'transcript' && e.body === 'echo: look +1img'));

    runner.kill('s1');
    expect(await exited).not.toBeUndefined();
    expect(runner.has('s1')).toBe(false);
  });

  it('rejects spawn with ENOENT when the binary is missing', async () => {
    const runner = new StreamRunner();
    await expect(
      runner.spawn({
        id: 's2',
        command: '/definitely/not/here',
        args: [],
        cwd: process.cwd(),
        env: {},
        input: { kind: 'stdin' },
        worktreePath: WT,
        firstMessage: null,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runner.has('s2')).toBe(false);
  });

  it('argv input: one process per turn, resume flag + chat id on the second turn', async () => {
    const runner = new StreamRunner();
    const effects: StreamEffect[] = [];
    runner.on('effect', (_id, e) => effects.push(e));
    const script = `
      const args = process.argv.slice(1);
      const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
      out({ type: 'system', subtype: 'init', session_id: 'chat-7' });
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'argv:' + args.join('|') }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
    `;
    await runner.spawn({
      id: 's3',
      command: process.execPath,
      args: ['-e', script, '--', '--print'],
      cwd: process.cwd(),
      env: {},
      input: { kind: 'argv', resumeFlag: '--resume' },
      worktreePath: WT,
      firstMessage: 'first',
    });
    const wait = (n: number) =>
      new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const tick = () =>
          effects.filter((e) => e.type === 'session' && e.event === 'quiet').length >= n
            ? resolve()
            : Date.now() - t0 > 5000
              ? reject(new Error('timeout'))
              : setTimeout(tick, 10);
        tick();
      });
    await wait(2); // result + process close both end the turn
    expect(runner.has('s3')).toBe(true);
    expect(effects.find((e) => e.type === 'transcript')).toMatchObject({ body: 'argv:--print|first' });
    // an argv runner is text-only: image blocks are dropped (warned), the text still goes as the next turn
    runner.send('s3', 'second', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
    await wait(4);
    expect(effects.filter((e) => e.type === 'transcript').at(-1)).toMatchObject({
      body: 'argv:--print|--resume|chat-7|second',
    });
    const exited = new Promise<number | null>((resolve) => runner.on('exit', (_id, code) => resolve(code)));
    runner.kill('s3');
    expect(await exited).toBeNull();
  });
});
