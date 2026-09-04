import { describe, expect, it } from 'vitest';
import { redact } from './logger';

describe('redact', () => {
  it('masks secret-named keys and secret-shaped strings', () => {
    const out = redact({ token: 'abc', nested: { accessKey: 'AKIAABCDEFGHIJKLMNOP', ok: 'fine' }, list: ['ghp_' + 'a'.repeat(36)] });
    expect(out).toEqual({ token: '[redacted]', nested: { accessKey: '[redacted]', ok: 'fine' }, list: ['[redacted]'] });
  });
});
