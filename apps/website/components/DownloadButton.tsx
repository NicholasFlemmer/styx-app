'use client';

import { useSyncExternalStore } from 'react';
import { detectPlatform, type Platform } from '@/lib/platform';

const noop = () => () => {};
const readPlatform = (): Platform => detectPlatform(navigator.userAgent, navigator.platform);

export const usePlatform = (): Platform =>
  useSyncExternalStore(noop, readPlatform, () => 'other' as Platform);

type Props = { primary?: boolean; small?: boolean; className?: string };

/** Every Download button opens the Download section, where the visitor picks Mac or Windows. */
export const DownloadButton = ({ primary = true, small = false, className }: Props) => (
  <a
    className={['btn', small ? 'btnSm' : '', className ?? ''].join(' ').trim()}
    data-on={primary ? 'true' : undefined}
    href="/#download"
  >
    Download
  </a>
);
