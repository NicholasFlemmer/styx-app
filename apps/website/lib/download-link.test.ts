import { describe, expect, it } from 'vitest';
import { classifyDownloadLink } from './download-link';

describe('classifyDownloadLink', () => {
  it.each([
    ['https://heystyx.com/download/mac', { kind: 'file', platform: 'mac' }],
    ['https://heystyx.com/download/win', { kind: 'file', platform: 'win' }],
    ['/download/win?ref=hero', { kind: 'file', platform: 'win' }],
    ['/download/mac/', { kind: 'file', platform: 'mac' }],
    ['/download', { kind: 'file', platform: 'mac' }],
    ['https://styx-api-994871833762.us-central1.run.app/download/win', { kind: 'file', platform: 'win' }],
    ['https://example.com/releases/Styx-0.4.0-arm64.dmg', { kind: 'file', platform: 'mac' }],
    ['https://example.com/releases/Styx-Setup-0.4.0.EXE?x=1', { kind: 'file', platform: 'win' }],
    ['https://example.com/Styx.msix', { kind: 'file', platform: 'win' }],
    ['/#download', { kind: 'section' }],
    ['#download', { kind: 'section' }],
    ['https://heystyx.com/#download', { kind: 'section' }],
    ['/downloads-are-great', null],
    ['/compare', null],
    ['', null],
  ])('%s', (href, expected) => {
    expect(classifyDownloadLink(href)).toEqual(expected);
  });
});
