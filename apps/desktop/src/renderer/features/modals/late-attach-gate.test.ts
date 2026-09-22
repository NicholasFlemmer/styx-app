import { describe, expect, it } from 'vitest';
import { lateAttachGate } from './login-terminal';

describe('lateAttachGate (a terminal attached after its pty started printing)', () => {
  it('writes the backlog first, drops held batches the backlog covered, then lets live bytes through', () => {
    const out: string[] = [];
    const gate = lateAttachGate((d) => out.push(d));
    gate.live('batch2', 2); // arrived while the backlog was being fetched; the backlog includes it
    gate.live('batch3', 3); // arrived after the backlog was taken
    gate.settle({ data: 'batch1batch2', seq: 2 });
    gate.live('batch4', 4);
    expect(out).toEqual(['batch1batch2', 'batch3', 'batch4']);
  });

  it('with nothing printed yet the live stream goes straight through once settled', () => {
    const out: string[] = [];
    const gate = lateAttachGate((d) => out.push(d));
    gate.settle({ data: '', seq: 0 });
    gate.live('a', 1);
    gate.settle({ data: 'ignored', seq: 9 }); // a second settle is a no-op
    gate.live('b', 2);
    expect(out).toEqual(['a', 'b']);
  });
});
