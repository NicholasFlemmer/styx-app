'use client';

import { formatShortcut } from '@/lib/platform';
import { usePlatform } from './DownloadButton';

/** A chord from tokens.json, in the visitor's platform glyphs (⌘ here, Ctrl on Windows). */
export const Shortcut = ({ chord }: { chord: string }) => {
  const platform = usePlatform();
  return <kbd suppressHydrationWarning>{formatShortcut(chord, platform)}</kbd>;
};
