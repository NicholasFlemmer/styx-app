'use client';

import { useSyncExternalStore } from 'react';
import { detectPlatform, type Platform } from '@/lib/platform';
import { site } from '@/lib/site';

const noop = () => () => {};
const readPlatform = (): Platform => detectPlatform(navigator.userAgent, navigator.platform);

export const usePlatform = (): Platform =>
  useSyncExternalStore(noop, readPlatform, () => 'other' as Platform);

type Props = { primary?: boolean; small?: boolean; className?: string };

/** One Download button: it fetches the build for the visitor's computer, or opens the Download section when it can't tell. */
export const DownloadButton = ({ primary = true, small = false, className }: Props) => {
  const platform = usePlatform();
  const win = platform === 'win';
  return (
    <a
      className={['btn', small ? 'btnSm' : '', className ?? ''].join(' ').trim()}
      data-on={primary ? 'true' : undefined}
      href={win ? site.links.downloadWin : platform === 'mac' ? site.links.downloadMac : '/#download'}
    >
      Download
    </a>
  );
};
