import { describe, expect, it } from 'vitest';
import { connectedAppUrlOk } from './connected-app';

describe('connectedAppUrlOk', () => {
  it.each([
    ['https://mcp.notion.com/mcp', true],
    ['http://127.0.0.1:3000/mcp', true],
    ['http://localhost:8080/mcp', true],
    ['http://[::1]:8080/mcp', true],
    ['http://mcp.example.com/mcp', false],
    ['https://user:pw@mcp.example.com/mcp', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
  ])('%s → %s', (url, ok) => {
    expect(connectedAppUrlOk(url)).toBe(ok);
  });
});
