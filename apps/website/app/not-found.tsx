import type { Metadata } from 'next';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';

/** A missing page is never a search result. */
export const metadata: Metadata = { title: 'Not found', robots: { index: false, follow: true } };

export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingBlock: 'var(--sp-24)' }}>
        <h1 style={{ font: '600 var(--fs-32)/1.15 var(--font-ui)', letterSpacing: '-0.02em' }}>
          Nothing here.
        </h1>
        <p style={{ marginTop: 'var(--sp-4)', color: 'var(--mu)', maxWidth: '32em' }}>
          The page you asked for does not exist. Everything about Styx is on the <a href="/">front page</a>.
        </p>
      </main>
      <Footer />
    </>
  );
}
