'use client';

import { useSyncExternalStore } from 'react';
import { detectPlatform, type Platform } from '@/lib/platform';
import { site } from '@/lib/site';

const noop = () => () => {};
const readPlatform = (): Platform => detectPlatform(navigator.userAgent, navigator.platform);

export const usePlatform = (): Platform =>
  useSyncExternalStore(noop, readPlatform, () => 'other' as Platform);

type Props = { primary?: boolean; small?: boolean; className?: string; note?: boolean };

/** The visitor's own platform first: Windows gets the Windows installer and the one honest line about the beta. */
export const DownloadButton = ({ primary = true, small = false, className, note = false }: Props) => {
  const platform = usePlatform();
  const win = platform === 'win';
  return (
    <>
      <a
        className={['btn', small ? 'btnSm' : '', className ?? ''].join(' ').trim()}
        data-on={primary ? 'true' : undefined}
        href={win ? site.links.downloadWin : site.links.downloadMac}
      >
        {win ? 'Download for Windows' : 'Download for Mac'}
      </a>
      {note && win && (
        <span suppressHydrationWarning style={{ color: 'var(--mu)', fontSize: 'var(--fs-13)' }}>
          Beta. Windows will ask before it runs.
        </span>
      )}
    </>
  );
};
