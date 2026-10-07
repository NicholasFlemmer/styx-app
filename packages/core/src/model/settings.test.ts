import { describe, expect, it } from 'vitest';
import { demoIdes } from '../fixtures/demo';
import type { IdeInstall } from './discovery';
import { DEFAULT_APP_SETTINGS, notifiesOnAsk, opensFilesInFallback, type NotifyMode } from './settings';

describe('notifiesOnAsk', () => {
  it.each<[NotifyMode, boolean, boolean]>([
    ['badge-sound', false, true],
    ['badge', false, true],
    ['off', false, false],
    ['badge-sound', true, false],
    ['badge', true, false],
    ['off', true, false],
  ])('notify %s, dnd %s → %s', (notify, dnd, expected) => {
    expect(notifiesOnAsk({ notify, dnd })).toBe(expected);
  });

  it('pops up by default', () => {
    expect(notifiesOnAsk(DEFAULT_APP_SETTINGS)).toBe(true);
  });
});

describe('opensFilesInFallback', () => {
  const ides = demoIdes();
  const noFallback: IdeInstall[] = ides.map((i) => ({ ...i, isFallback: false }));
  const noLauncher: IdeInstall[] = ides.map((i) => ({ ...i, launcher: null }));

  it.each<[string, 'styx' | 'fallback', IdeInstall['kind'] | null, readonly IdeInstall[], boolean]>([
    ['Styx, whatever is installed', 'styx', 'vscode', ides, false],
    ['fallback, the detected fallback has a launcher', 'fallback', null, ides, true],
    ['fallback, picked by kind when none is flagged', 'fallback', 'cursor', noFallback, true],
    ['fallback, nothing flagged or picked', 'fallback', null, noFallback, false],
    ['fallback, the picked editor is not installed', 'fallback', 'zed', noFallback, false],
    ['fallback, no launcher to hand the file to', 'fallback', null, noLauncher, false],
    ['fallback, no editors found', 'fallback', 'vscode', [], false],
  ])('%s', (_name, openFilesIn, fallbackIde, list, expected) => {
    expect(opensFilesInFallback({ openFilesIn, fallbackIde }, list)).toBe(expected);
  });
});
