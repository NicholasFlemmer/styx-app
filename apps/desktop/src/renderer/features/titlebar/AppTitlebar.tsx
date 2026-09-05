import { copy, fill, lockedCount, needsYouCount, projectBranch, projectNameOf } from '@styx/core';
import { Titlebar, TitlebarCounter, TitlebarField, Wordmark } from '@styx/ui';
import { useCallback } from 'react';
import { chromePlatform, platform } from '../../state/bridge';
import { useModel, useNow, useUi } from '../../state/hooks';
import s from './AppTitlebar.module.css';

/** "{n} needs you" → "needs you": TitlebarCounter renders the numeral itself. */
const counterLabel = (template: string): string => fill(template, { n: '' }).trim();

/** Titlebar (spec §3): wordmark, project button (palette in Projects scope), branch, palette field, two counters. */
export function AppTitlebar() {
  const projectId = useUi((u) => u.projectId);
  const openPalette = useUi((u) => u.openPalette);
  const now = useNow();
  // Prototype: `projectName: 'No project'`, `branchName: ''` when nothing is selected (the branch span stays for its gap).
  const projectName = useModel(
    useCallback((m) => (projectId === null ? copy.empty.noProject : projectNameOf(m, projectId)), [projectId]),
  );
  const branch = useModel(
    useCallback((m) => (projectId === null ? '' : projectBranch(m, projectId)), [projectId]),
  );
  const needs = useModel(needsYouCount);
  const locked = useModel(
    useCallback((m) => (projectId === null ? 0 : lockedCount(m, projectId, now)), [projectId, now]),
  );
  const chrome = chromePlatform();

  return (
    <Titlebar
      platform={chrome}
      left={
        <>
          <Wordmark>{copy.app.wordmark}</Wordmark>
          <span className={s['divider']} aria-hidden="true" />
          <button
            type="button"
            className={s['project']}
            onClick={() => openPalette('projects')}
            aria-label={`${projectName} — switch project`}
            aria-haspopup="dialog"
          >
            {projectName} <span className={s['chevron']}>▾</span>
          </button>
          <span className={s['branch']}>{branch}</span>
        </>
      }
      right={
        <>
          {/* Layout follows the visual chrome; the shortcut hint follows the keyboard platform (Mod = ⌘ on darwin). */}
          <TitlebarField
            platform={platform()}
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
