'use client';

import { useState } from 'react';

/** "Copy page as Markdown": fetches the page's Markdown (/md/docs/…) and puts it on the clipboard, for an agent. */
export function CopyMarkdown({ url, className }: { url: string; className?: string | undefined }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          const text = await (await fetch(url)).text();
          await navigator.clipboard.writeText(text);
          setState('copied');
        } catch {
          setState('failed');
        }
        setTimeout(() => setState('idle'), 1600);
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy page as Markdown'}
    </button>
  );
}
