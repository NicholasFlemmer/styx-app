import { describe, expect, it } from 'vitest';
import { isLocalDevUrl, normaliseDevUrl } from './dev-url';

describe('isLocalDevUrl', () => {
  it.each([
    ['localhost:3000', true],
    ['http://localhost:5173/app', true],
    ['https://127.0.0.1:8443', true],
    ['http://[::1]:3000', true],
    ['http://127.1:3000', true],
    ['http://localhost.:3000', false],
    ['http://user:pw@localhost:3000', false],
    ['http://localhost@evil.example/', false],
    ['http://lvh.me:3000', false],
    ['https://attacker.example/login', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['', false],
    ['not a url', false],
  ])('%s → %s', (url, ok) => {
    expect(isLocalDevUrl(url)).toBe(ok);
  });

  it('normalises a bare host:port to http', () => {
    expect(normaliseDevUrl(' localhost:3000 ')).toBe('http://localhost:3000');
    expect(normaliseDevUrl('https://localhost')).toBe('https://localhost');
  });
});
