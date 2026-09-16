import { copy, fill, formatChord, lockedCount, needsYouCount } from '@styx/core';
import { shortcuts } from '@styx/tokens';
import { Titlebar, TitlebarCounter, TitlebarField, Wordmark } from '@styx/ui';
import { useCallback } from 'react';
import { chromePlatform, platform } from '../../state/bridge';
import { useModel, useNow, useUi } from '../../state/hooks';

/** "{n} needs you" → "needs you": TitlebarCounter renders the numeral itself. */
const counterLabel = (template: string): string => fill(template, { n: '' }).trim();

/**
 * Titlebar (spec §3, owner layout #85): wordmark, palette field, two counters. The project dropdown and branch
 * moved out: the project rail switches projects and the project nav's head shows the name and branch.
 */
export function AppTitlebar() {
  const projectId = useUi((u) => u.projectId);
  const openPalette = useUi((u) => u.openPalette);
  const now = useNow();
  const needs = useModel(needsYouCount);
  const locked = useModel(
    useCallback((m) => (projectId === null ? 0 : lockedCount(m, projectId, now)), [projectId, now]),
  );
  const chrome = chromePlatform();

  return (
    <Titlebar
      platform={chrome}
      left={<Wordmark>{copy.app.wordmark}</Wordmark>}
      right={
        <>
          {/* Layout follows the visual chrome; the shortcut hint follows the keyboard platform (Mod = ⌘ on darwin). */}
          <TitlebarField
            platform={platform()}
            hint={formatChord(shortcuts.palette, platform())}
            placeholder={copy.palette.titlebarField}
            onClick={() => openPalette('all')}
          />
          <TitlebarCounter
            count={needs}
            label={counterLabel(copy.counters.titlebarNeedsYou)}
            tone="accent"
            live
          />
          <TitlebarCounter
            count={locked}
            label={counterLabel(copy.counters.titlebarLocked)}
            tone="hollowStrong"
          />
        </>
      }
    />
  );
}
