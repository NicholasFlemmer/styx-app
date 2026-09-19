import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CliWatchService } from './cli-watch-service';

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
// fs.watch on macOS can take seconds to deliver under a full parallel test run; the budget is generous on purpose.

describe('CliWatchService (#98)', () => {
  it('re-detects once per burst of changes in a watched folder; released and stopped folders are quiet', { timeout: 30_000 }, async () => {
    const a = mkdtempSync(join(tmpdir(), 'styx-watch-a-'));
    const b = mkdtempSync(join(tmpdir(), 'styx-watch-b-'));
    const onChange = vi.fn(async () => undefined);
    const svc = new CliWatchService({ onChange, debounceMs: 50 });
    svc.update([a]); // before start nothing is watched
    expect(svc.size).toBe(0);
    svc.start();
    svc.update([a, join(a, 'missing')]); // a folder that is not there is skipped, not fatal
    expect(svc.size).toBe(1);
    writeFileSync(join(a, 'claude'), '');
    writeFileSync(join(a, 'codex'), '');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    await settle(150);
    expect(onChange).toHaveBeenCalledTimes(1); // both writes fell into one debounce window

    svc.update([b]); // a released, b watched
    expect(svc.size).toBe(1);
    writeFileSync(join(b, 'gemini'), '');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2), { timeout: 15_000 });
    writeFileSync(join(a, 'gemini'), '');
    await settle(150);
    expect(onChange).toHaveBeenCalledTimes(2);

    svc.stop();
    expect(svc.size).toBe(0);
    writeFileSync(join(b, 'agent'), '');
    await settle(150);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('a re-detect that throws is logged, not raised into the fs callback', { timeout: 30_000 }, async () => {
    const a = mkdtempSync(join(tmpdir(), 'styx-watch-c-'));
    const onChange = vi.fn(async () => {
      throw new Error('detect blew up');
    });
    const svc = new CliWatchService({ onChange, debounceMs: 20 });
    svc.start();
    svc.update([a]);
    writeFileSync(join(a, 'claude'), '');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    await settle(60);
    svc.stop();
  });
});
