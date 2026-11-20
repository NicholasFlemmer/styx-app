import { describe, expect, it } from 'vitest';
import { LineSplitter } from './line-splitter';

describe('LineSplitter', () => {
  it('splits lines across any chunking and keeps the unfinished rest', () => {
    const s = new LineSplitter();
    expect(s.push('a\nb')).toEqual(['a']);
    expect(s.push('c')).toEqual([]);
    expect(s.push('d\n\ne\nf')).toEqual(['bcd', '', 'e']);
    expect(s.rest()).toBe('f');
    expect(s.rest()).toBe('');
  });

  it('reads a 40 MB line in 64 KB chunks in linear time', () => {
    const s = new LineSplitter();
    const chunk = 'x'.repeat(64 * 1024);
    const t0 = performance.now();
    for (let i = 0; i < 640; i++) expect(s.push(chunk)).toEqual([]);
    const [line] = s.push('\n');
    expect(line?.length).toBe(640 * 64 * 1024);
    // The old way took minutes for this; anything linear is well under a second.
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
