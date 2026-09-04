import { copy, fill, lockedCount, needsYouCount, projectBranch, projectNameOf } from '@styx/core';
import { Titlebar, TitlebarCounter, TitlebarField, Wordmark } from '@styx/ui';
import { useCallback } from 'react';
import { chromePlatform } from '../../state/bridge';
import { useModel, useNow, useUi } from '../../state/hooks';
import s from './AppTitlebar.module.css';

/** "{n} needs you" → "needs you": TitlebarCounter renders the numeral itself. */
const counterLabel = (template: string): string => fill(template, { n: '' }).trim();

/** Titlebar (spec §3): wordmark, project button (palette in Projects scope), branch, palette field, two counters. */
export function AppTitlebar() {
  const projectId = useUi((u) => u.projectId);
  const openPalette = useUi((u) => u.openPalette);
  const now = useNow();
  const projectName = useModel(
    useCallback((m) => (projectId === null ? copy.general.none : projectNameOf(m, projectId)), [projectId]),
  );
  const branch = useModel(
    useCallback((m) => (projectId === null ? copy.general.none : projectBranch(m, projectId)), [projectId]),
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
          <TitlebarField
            platform={chrome}
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
