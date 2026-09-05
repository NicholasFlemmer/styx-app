import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PtyLog, REDACT_TAIL } from './pty-log';

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

  it('writes immediately (no held-back output) and still rotates at the size cap, carrying the tail into the new file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-ptylog-'));
    const log = new PtyLog(dir, 12_000);
    log.write('s3', 'thinking…');
    expect(readFileSync(log.path('s3'), 'utf8')).toBe('thinking…');
    const a = 'a'.repeat(8_000);
    const b = 'b'.repeat(8_000);
    log.write('s3', a);
    log.write('s3', b);
    log.close('s3');
    // The last REDACT_TAIL chars of the old file move to the head of the new one; nothing is lost or duplicated.
    const rotated = readFileSync(`${log.path('s3')}.1`, 'utf8');
    const current = readFileSync(log.path('s3'), 'utf8');
    expect(rotated + current).toBe(`thinking…${a}${b}`);
    expect(rotated).toBe(`thinking…${a}`.slice(0, -REDACT_TAIL));
    expect(current.startsWith('a'.repeat(REDACT_TAIL))).toBe(true);
  });

  it('L-a: a JWT split across chunks (longer than the old 128-char tail) is redacted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-ptylog-'));
    const log = new PtyLog(dir);
    const jwt = `eyJ${'h'.repeat(300)}.eyJ${'p'.repeat(900)}.${'s'.repeat(400)}`;
    const cut = 200; // inside the header segment, well past 128 chars of the first chunk
    log.write('s4', `Bearer ${jwt.slice(0, cut)}`);
    log.write('s4', `${jwt.slice(cut, 1000)}`);
    log.write('s4', `${jwt.slice(1000)}\r\n`);
    log.close('s4');
    const text = readFileSync(log.path('s4'), 'utf8');
    expect(text).not.toContain('eyJ');
    expect(text).toBe('Bearer [redacted]\r\n');
  });

  it('L-a: a secret whose first half was written before the rotation is still redacted (tail carried across files)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-ptylog-'));
    const log = new PtyLog(dir, 6_000);
    const ghp = `ghp_${'g'.repeat(36)}`;
    log.write('s5', 'x'.repeat(5_000));
    log.write('s5', `${'y'.repeat(985)}${ghp.slice(0, 10)}`); // 5 995 bytes: no rotation yet
    log.write('s5', ghp.slice(10, 20)); // 6 005 > 6 000: rotates; the carried tail holds the `ghp_` prefix
    log.write('s5', `${ghp.slice(20)} tail\r\n`); // completes the token: the fix-up reaches back through the carried tail
    log.close('s5');
    const rotated = readFileSync(`${log.path('s5')}.1`, 'utf8');
    const current = readFileSync(log.path('s5'), 'utf8');
    expect(rotated).toBe('x'.repeat(5_995 - REDACT_TAIL));
    expect(rotated + current).toBe(`${'x'.repeat(5_000)}${'y'.repeat(985)}[redacted] tail\r\n`);
  });

  it('L-1: a surrogate pair split across chunks does not drift the tail byte accounting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'styx-ptylog-'));
    const log = new PtyLog(dir);
    const emoji = '😀'; // U+1F600 = \uD83D\uDE00
    const ghp = `ghp_${'k'.repeat(36)}`;
    log.write('s6', `a${emoji[0]}`);
    log.write('s6', `${emoji[1]}b ${ghp.slice(0, 8)}`);
    log.write('s6', `${ghp.slice(8)}\r\n`);
    log.close('s6');
    const text = readFileSync(log.path('s6'), 'utf8');
    expect(text).toBe('a\uFFFD\uFFFDb [redacted]\r\n');
  });
});
