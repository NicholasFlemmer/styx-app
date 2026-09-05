import { describe, expect, it } from 'vitest';
import {
  permissionResponseLine,
  relPath,
  StreamParser,
  StreamRunner,
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
    expect(fx).toContainEqual({ type: 'init', chatId: 'abc-123', model: 'claude-fable-5' });
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

  it('result → quiet (idle); an error result also posts an error', () => {
    expect(parseAll([RESULT])).toEqual([
      { type: 'render', text: '— done in 1.2s\r\n' },
      { type: 'session', event: 'quiet' },
    ]);
    const err = parseAll([RESULT_ERR]);
    expect(err).toContainEqual({ type: 'error', message: 'boom' });
    expect(err.at(-1)).toEqual({ type: 'session', event: 'quiet' });
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

  it('stdin lines are single-line JSON', () => {
    expect(JSON.parse(userTurnLine('hi\nthere'))).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi\nthere' }] },
    });
    expect(userTurnLine('x').endsWith('\n')).toBe(true);
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
    const text = m.message.content[0].text;
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ' + text }] } });
    if (text === 'danger') out({ type: 'control_request', request_id: 'req-9', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm' } } });
    else out({ type: 'result', subtype: 'success', is_error: false, result: 'echo: ' + text, duration_ms: 5 });
  } else if (m.type === 'control_response') {
    out({ type: 'result', subtype: 'success', is_error: false, result: m.response.response.behavior, duration_ms: 1 });
  }
});
rl.on('close', () => process.exit(0));
`;

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
    expect(effects.filter((e) => e.type === 'session' && e.event === 'quiet')).toHaveLength(1);

    runner.send('s1', 'danger');
    await until(() => effects.some((e) => e.type === 'permission'));
    runner.respondPermission('s1', 'req-9', true);
    await until(() =>
      effects.some(
        (e) =>
          e.type === 'session' &&
          e.event === 'quiet' &&
          effects.indexOf(e) > 0 &&
          effects.filter((x) => x.type === 'session' && x.event === 'quiet').length === 2,
      ),
    );

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
    runner.send('s3', 'second');
    await wait(4);
    expect(effects.filter((e) => e.type === 'transcript').at(-1)).toMatchObject({
      body: 'argv:--print|--resume|chat-7|second',
    });
    const exited = new Promise<number | null>((resolve) => runner.on('exit', (_id, code) => resolve(code)));
    runner.kill('s3');
    expect(await exited).toBeNull();
  });
});
