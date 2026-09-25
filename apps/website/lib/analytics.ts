/**
 * Analytics, through Google Tag Manager only: GA4 and anything added later (ads pixels, heatmaps) are
 * configured inside the GTM container, so the site never needs a redeploy for a new tag.
 *
 * Consent Mode v2: storage is denied until the visitor accepts. Denied visitors still send cookieless pings,
 * which GA models into totals, so a decline costs detail, not the count.
 */
export const GTM_ID = process.env['NEXT_PUBLIC_GTM_ID'] ?? '';

export type Consent = 'granted' | 'denied';
export const CONSENT_KEY = 'styx-consent';
/** Dispatched on window to reopen the cookie choice (footer and privacy policy links). */
export const OPEN_CONSENT_EVENT = 'styx:open-consent';
/** Dispatched on window after the choice is saved, so anything reading it can re-read. */
export const CONSENT_CHANGED_EVENT = 'styx:consent-changed';

type DataLayer = unknown[];
const layer = (): DataLayer | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { dataLayer?: DataLayer };
  w.dataLayer = w.dataLayer ?? [];
  return w.dataLayer;
};

/** gtag's calling convention: GTM reads `arguments` objects pushed onto the data layer. */
function gtag(..._args: unknown[]): void {
  // eslint-disable-next-line prefer-rest-params
  layer()?.push(arguments);
}

export const setConsent = (c: Consent): void => {
  try {
    localStorage.setItem(CONSENT_KEY, c);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  gtag('consent', 'update', {
    analytics_storage: c,
    ad_storage: c,
    ad_user_data: c,
    ad_personalization: c,
  });
  layer()?.push({ event: 'consent_update', consent: c });
  window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
};

export const readConsent = (): Consent | null => {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null;
  }
};

/** A named event for GTM to route to GA4 (and anything else). Keep names snake_case, GA4's convention. */
export const track = (event: string, params: Record<string, string | number | boolean> = {}): void => {
  layer()?.push({ event, ...params });
};

/**
 * Runs before GTM loads: defaults every storage type to denied (granted only if the visitor already
 * accepted on a previous visit), so no cookie is ever set ahead of a choice.
 */
export const consentDefaultsScript = `(function(){window.dataLayer=window.dataLayer||[];function g(){dataLayer.push(arguments)}var c=null;try{c=localStorage.getItem('${CONSENT_KEY}')}catch(e){}var s=c==='granted'?'granted':'denied';g('consent','default',{analytics_storage:s,ad_storage:s,ad_user_data:s,ad_personalization:s,functionality_storage:'granted',security_storage:'granted',wait_for_update:500});g('set','url_passthrough',true);g('set','ads_data_redaction',true);})();`;

export const gtmScript = (id: string): string =>
  `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${id}');`;
