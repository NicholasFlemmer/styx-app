'use client';

import { OPEN_CONSENT_EVENT } from '@/lib/analytics';

/** Reopens the cookie choice. Withdrawing consent has to be as easy as giving it. */
export const CookieSettingsLink = ({ label = 'open cookie settings' }: { label?: string }) => (
  <button
    type="button"
    onClick={() => window.dispatchEvent(new Event(OPEN_CONSENT_EVENT))}
    style={{
      font: 'inherit',
      color: 'inherit',
      background: 'none',
      border: 0,
      padding: 0,
      textDecoration: 'underline',
      cursor: 'pointer',
    }}
  >
    {label}
  </button>
);
