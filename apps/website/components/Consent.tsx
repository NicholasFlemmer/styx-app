'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { CONSENT_CHANGED_EVENT, GTM_ID, OPEN_CONSENT_EVENT, readConsent, setConsent } from '@/lib/analytics';
import styles from './Consent.module.css';

const subscribe = (onChange: () => void) => {
  window.addEventListener(CONSENT_CHANGED_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CONSENT_CHANGED_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
};
/** No choice saved yet. False on the server, so the static page never ships with the banner in it. */
const needsChoice = () => Boolean(GTM_ID) && readConsent() === null;

/**
 * The cookie choice, in the site's own vocabulary: a floating surface with a 1px text border, two plain
 * buttons, accept armed in lime. Shown until a choice is saved, and again whenever "Cookie settings" asks.
 */
export const Consent = () => {
  const pending = useSyncExternalStore(subscribe, needsChoice, () => false);
  const [reopened, setReopened] = useState(false);
  useEffect(() => {
    const reopen = () => setReopened(true);
    window.addEventListener(OPEN_CONSENT_EVENT, reopen);
    return () => window.removeEventListener(OPEN_CONSENT_EVENT, reopen);
  }, []);
  if (!pending && !reopened) return null;
  const choose = (c: 'granted' | 'denied') => {
    setConsent(c);
    setReopened(false);
  };
  return (
    <div className={styles.consent} role="region" aria-label="Cookie choice">
      <p className={styles.text}>
        We use cookies to see which pages and links bring people to Styx. Nothing from the app, ever.
      </p>
      <div className={styles.actions}>
        <button type="button" className="btn btnSm" onClick={() => choose('denied')}>
          Decline
        </button>
        <button type="button" className="btn btnSm" data-on="true" onClick={() => choose('granted')}>
          Accept
        </button>
      </div>
    </div>
  );
};
