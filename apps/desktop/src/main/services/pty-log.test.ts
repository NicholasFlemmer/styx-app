import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PtyLog } from './pty-log';

describe('PtyLog', () => {
  it('L5: redacts secret-shaped output before it reaches the on-disk log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-ptylog-'));
    const log = new PtyLog(dir);
    const ghp = `ghp_${'e'.repeat(36)}`;
    log.write('s1', `$ gh auth login --with-token ${ghp}\r\n`);
    log.write('s1', 'AWS key AKIAABCDEFGHIJKLMNOP and plain text\r\n');
    log.close('s1');
    const text = readFileSync(log.path('s1'), 'utf8');
    expect(text).not.toContain(ghp);
    expect(text).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(text).toContain('--with-token [redacted]');
    expect(text).toContain('plain text');
  });

  it('L5: catches a secret split across two pty chunks and flushes the held tail on close', () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-ptylog-'));
    const log = new PtyLog(dir);
    const ghp = `ghp_${'f'.repeat(36)}`;
    log.write('s2', `token: ${ghp.slice(0, 12)}`);
    log.write('s2', `${ghp.slice(12)} done\r\n`);
    log.write('s2', `${'x'.repeat(300)}\r\n`);
    log.close('s2');
    const text = readFileSync(log.path('s2'), 'utf8');
    expect(text).not.toContain(ghp);
    expect(text).toBe(`token: [redacted] done\r\n${'x'.repeat(300)}\r\n`);
  });

  it('writes immediately (no held-back output) and still rotates at the size cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-ptylog-'));
    const log = new PtyLog(dir, 400);
    log.write('s3', 'thinking…');
    expect(readFileSync(log.path('s3'), 'utf8')).toBe('thinking…');
    log.write('s3', 'a'.repeat(300));
    log.write('s3', 'b'.repeat(300));
    log.close('s3');
    expect(readFileSync(`${log.path('s3')}.1`, 'utf8')).toBe(`thinking…${'a'.repeat(300)}`);
    expect(readFileSync(log.path('s3'), 'utf8')).toBe('b'.repeat(300));
  });
});
