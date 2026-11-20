import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { MAX_LINE, onNdjson } from './ndjson';

const fakeSocket = () => {
  const e = new EventEmitter() as EventEmitter & {
    setEncoding: () => void;
    destroy: () => void;
    destroyed: boolean;
  };
  e.destroyed = false;
  e.setEncoding = () => undefined;
  e.destroy = () => {
    e.destroyed = true;
  };
  return e;
};

describe('onNdjson', () => {
  it('reads messages split across any chunks, and reports bad lines', () => {
    const s = fakeSocket();
    const got: unknown[] = [];
    const bad: string[] = [];
    onNdjson(
      s as unknown as Socket,
      (m) => got.push(m),
      (r) => bad.push(r),
    );
    s.emit('data', '{"a":1}\n{"b"');
    s.emit('data', ':2}\n\nnot json\n{"c":');
    s.emit('data', '3}\n');
    expect(got).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(bad).toEqual(['not json']);
  });

  it('cuts off a peer whose message never ends, instead of filling memory', () => {
    const s = fakeSocket();
    const bad: string[] = [];
    onNdjson(
      s as unknown as Socket,
      () => undefined,
      (r) => bad.push(r),
    );
    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i <= MAX_LINE / chunk.length && !s.destroyed; i++) s.emit('data', chunk);
    expect(s.destroyed).toBe(true);
    expect(bad).toEqual(['(message too long)']);
  });
});
