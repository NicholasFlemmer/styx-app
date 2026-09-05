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
});
