'use client';

import { useEffect } from 'react';
import { track } from '@/lib/analytics';
import { classifyDownloadLink } from '@/lib/download-link';

/**
 * Where on the page a link sits, in words a report can use: the top bar is `nav`; a section is its id, or
 * the id of the heading that names it (`hero-title` -> `hero`); anything else is `page`.
 */
const placeOf = (el: Element): string => {
  if (el.closest('header')) return 'nav';
  const sec = el.closest('section');
  if (!sec) return 'page';
  if (sec.id) return sec.id;
  const named = sec.getAttribute('aria-labelledby');
  return named ? named.replace(/-title$/, '') : 'page';
};

/**
 * The launch questions, as events: did they download, how far did they read, where did they click out.
 * One delegated listener and one observer; no per-component wiring.
 */
export const Tracking = () => {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a');
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      const label = (a.textContent ?? '').trim().slice(0, 60);
      const dl = classifyDownloadLink(href);
      if (dl?.kind === 'file') {
        // An actual download, Mac, Windows or Linux (GA4 download_click; the Meta pixel's Lead).
        track('download_click', { platform: dl.platform, link_text: label, link_url: href, location: placeOf(a) });
      } else if (dl?.kind === 'section') {
        // A button that only opens the Download section, where the visitor then picks Mac, Windows or Linux.
        track('download_open', { link_text: label, location: placeOf(a) });
      } else if (/^https?:\/\//.test(href) && !href.includes(location.host)) {
        track('outbound_click', { link_url: href, link_text: label });
      }
    };
    document.addEventListener('click', onClick);

    // Which sections people actually reach, each once per visit.
    const seen = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const id = (en.target as HTMLElement).id;
          if (en.isIntersecting && id && !seen.has(id)) {
            seen.add(id);
            track('section_view', { section: id });
          }
        }
      },
      { threshold: 0.4 },
    );
    document.querySelectorAll('section[id]').forEach((s) => io.observe(s));
    return () => {
      document.removeEventListener('click', onClick);
      io.disconnect();
    };
  }, []);
  return null;
};
