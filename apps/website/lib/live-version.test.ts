import { describe, expect, it } from 'vitest';
import { parseFeedVersion } from './live-version';

describe('parseFeedVersion', () => {
  it.each([
    ['version: 0.4.7\nfiles:\n  - url: Styx-0.4.7-arm64-mac.zip\n', '0.4.7'],
    ["files: []\nversion: '1.2.3-beta.1'\n", '1.2.3-beta.1'],
    ['version: 0.4.7<script>\n', null],
    ['<html>Not found</html>', null],
    ['', null],
  ])('%j → %s', (text, expected) => {
    expect(parseFeedVersion(text)).toBe(expected);
  });
});
