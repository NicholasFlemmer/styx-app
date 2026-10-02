import type { Metadata } from 'next';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { DownloadButton } from '@/components/DownloadButton';
import { site } from '@/lib/site';
import styles from '../story/Story.module.css';

/**
 * The 21-second demo: one grant, start to finish, cut from the hero demo's own markup. Served from the site
 * itself (no player, no third-party tracking); it has no voice, so the page carries what the video says.
 */
const VIDEO = '/demo/styx-demo-2026-09-30.mp4';
const POSTER = '/demo/poster.jpg';
const PUBLISHED = '2026-09-30';

export const metadata: Metadata = {
  title: { absolute: 'Styx in 21 seconds: your agent asks before it touches prod' },
  description:
    'Codex tries to push a migration to a live database. Styx stops it, asks you, and gives it one hour of write access after Touch ID. On the record.',
  alternates: { canonical: '/demo' },
  openGraph: {
    title: 'Styx in 21 seconds',
    description: 'Your agent just tried to touch prod. Nothing crosses without you.',
    url: '/demo',
    type: 'video.other',
    images: [{ url: POSTER, width: 1920, height: 1080, alt: 'A Styx access request for Supabase prod db' }],
    videos: [{ url: `${site.url}${VIDEO}`, type: 'video/mp4', width: 1920, height: 1080 }],
  },
};

const SCRIPT = [
  'Your agent just tried to touch prod: Codex runs supabase db push, and Styx stops it with “prod db needs a grant (write)”.',
  'Every project. Every agent. Every key. One window.',
  'Codex wants your live database. The counter reads 01 needs you, and the request lands in the chat.',
  'It waits. You pick the scope and the hour: read schema and write, not delete, for one hour.',
  'Approved with Touch ID. Gone in an hour. The migration is applied.',
  'Every pass written down. Keys stay on your Mac. Nothing crosses without you.',
];

const schema = {
  '@context': 'https://schema.org',
  '@type': 'VideoObject',
  name: 'Styx in 21 seconds',
  description:
    'A coding agent asks for write access to a production database; Styx pauses it, the developer approves one hour with Touch ID, and the grant is logged.',
  thumbnailUrl: [`${site.url}${POSTER}`],
  uploadDate: PUBLISHED,
  duration: 'PT21S',
  contentUrl: `${site.url}${VIDEO}`,
  embedUrl: `${site.url}/demo`,
  transcript: SCRIPT.join(' '),
  inLanguage: 'en',
  publisher: { '@type': 'Organization', name: site.name, url: `${site.url}/` },
};

export default function DemoPage() {
  return (
    <>
      <a href="#main" className="srOnly">
        Skip to content
      </a>
      <Nav />
      <main id="main" className={styles.page}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }}
        />
        <div className="wrap">
          <header className={styles.head}>
            <p className={styles.kicker}>The demo · 0:21</p>
            <h1>Styx in 21 seconds</h1>
            <p className={styles.lede}>Your agent just tried to touch prod. Here is what happens next.</p>
          </header>
          <figure className={styles.player}>
            <video controls playsInline preload="metadata" poster={POSTER} width={1920} height={1080}>
              <source src={VIDEO} type="video/mp4" />
              Your browser can’t play this video. What it shows is below.
            </video>
          </figure>
          <div className={styles.cta}>
            <DownloadButton />
            <span className={styles.note}>Free · Mac · Windows beta</span>
          </div>
          <section className={styles.transcript} aria-labelledby="on-screen">
            <h2 id="on-screen">On screen</h2>
            {SCRIPT.map((p) => (
              <p key={p.slice(0, 24)}>{p}</p>
            ))}
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
