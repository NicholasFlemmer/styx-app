'use client';

import { useEffect, useState } from 'react';
import { FEED_URL, parseFeedVersion } from '@/lib/live-version';

/** The version the update feed serves now; `fallback` (the build's) until it answers, or if it can't be read. */
export const LiveVersion = ({ fallback }: { fallback: string }) => {
  const [version, setVersion] = useState(fallback);
  useEffect(() => {
    const ctl = new AbortController();
    fetch(FEED_URL, { cache: 'no-store', signal: ctl.signal })
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        const live = parseFeedVersion(text);
        if (live) setVersion(live);
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, []);
  return <>{version}</>;
};
