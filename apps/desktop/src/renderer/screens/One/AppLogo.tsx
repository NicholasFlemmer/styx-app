import {
  siAirtable,
  siAsana,
  siAtlassian,
  siBox,
  siCalendly,
  siCloudflare,
  siFigma,
  siFlydotio,
  siGithub,
  siGoogleads,
  siGoogleanalytics,
  siGooglecloud,
  siHubspot,
  siIntercom,
  siLinear,
  siMailchimp,
  siMeta,
  siNotion,
  siPaypal,
  siRailway,
  siRender,
  siSentry,
  siShopify,
  siSquare,
  siStripe,
  siSupabase,
  siVercel,
  siWebflow,
  siWix,
  siZapier,
} from 'simple-icons';
import s from './AppLogo.module.css';

/** Brand marks from Simple Icons (CC0), drawn in the text colour: one look, every theme (ADR-0033). */
const PATHS: Record<string, string> = {
  airtable: siAirtable.path,
  asana: siAsana.path,
  atlassian: siAtlassian.path,
  box: siBox.path,
  calendly: siCalendly.path,
  cloudflare: siCloudflare.path,
  figma: siFigma.path,
  fly: siFlydotio.path,
  github: siGithub.path,
  googleads: siGoogleads.path,
  googleanalytics: siGoogleanalytics.path,
  gcp: siGooglecloud.path,
  hubspot: siHubspot.path,
  intercom: siIntercom.path,
  linear: siLinear.path,
  mailchimp: siMailchimp.path,
  'meta-ads': siMeta.path,
  notion: siNotion.path,
  paypal: siPaypal.path,
  railway: siRailway.path,
  render: siRender.path,
  sentry: siSentry.path,
  shopify: siShopify.path,
  square: siSquare.path,
  stripe: siStripe.path,
  supabase: siSupabase.path,
  vercel: siVercel.path,
  webflow: siWebflow.path,
  wix: siWix.path,
  zapier: siZapier.path,
};

/** An app's mark, or its initials on a square when there is no open mark for it. Decorative: the name is beside it. */
export function AppLogo({
  id,
  name,
  size = 'regular',
}: {
  id: string;
  name: string;
  size?: 'regular' | 'small';
}) {
  const path = PATHS[id];
  return (
    <span className={s['tile']} data-size={size} aria-hidden="true">
      {path === undefined ? (
        <span className={s['initials']}>
          {name
            .split(/\s+/)
            .map((w) => w[0] ?? '')
            .join('')
            .slice(0, 2)
            .toUpperCase()}
        </span>
      ) : (
        <svg viewBox="0 0 24 24" className={s['svg']} focusable="false">
          <path d={path} />
        </svg>
      )}
    </span>
  );
}
