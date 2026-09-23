'use client';

import { useSyncExternalStore } from 'react';
import { detectPlatform, type Platform } from '@/lib/platform';
import { site } from '@/lib/site';

const noop = () => () => {};
const readPlatform = (): Platform => detectPlatform(navigator.userAgent, navigator.platform);

export const usePlatform = (): Platform =>
  useSyncExternalStore(noop, readPlatform, () => 'other' as Platform);

type Props = { primary?: boolean; small?: boolean; className?: string; note?: boolean };

/** Mac is what ships first; a Windows visitor gets the button plus one honest line. */
export const DownloadButton = ({ primary = true, small = false, className, note = false }: Props) => {
  const platform = usePlatform();
  return (
    <>
      <a
        className={['btn', small ? 'btnSm' : '', className ?? ''].join(' ').trim()}
        data-on={primary ? 'true' : undefined}
        href={site.links.downloadMac}
      >
        Download for macOS
      </a>
      {note && platform === 'win' && (
        <span suppressHydrationWarning style={{ color: 'var(--mu)', fontSize: 'var(--fs-13)' }}>
          Windows is coming soon.
        </span>
      )}
    </>
  );
};
