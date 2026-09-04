import { describe, expect, it } from 'vitest';
import { PtyService } from './pty-service';

let available = true;
try {
  await import('node-pty');
} catch {
  available = false;
}

describe.skipIf(!available)('PtyService', () => {
  it('spawns a shell, echoes input, and reports exit', async () => {
    const pty = new PtyService();
    const chunks: string[] = [];
    pty.on('data', (_id, d) => chunks.push(d));
    const exited = new Promise<number>((resolve) => pty.on('exit', (_id, code) => resolve(code)));
    await pty.spawn({ id: 's1', cwd: process.cwd(), shell: '/bin/sh', args: ['-c', 'echo __hello__; exit 3'] });
    const code = await exited;
    expect(code).toBe(3);
    expect(chunks.join('')).toContain('__hello__');
  });

  it('resolves a login PATH', async () => {
    const pty = new PtyService();
    const p = await pty.resolveLoginPath();
    expect(p.length).toBeGreaterThan(0);
  });
});
