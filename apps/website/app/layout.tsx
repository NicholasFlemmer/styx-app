import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import tokens from '@styx/tokens/tokens.json';
import '@styx/tokens/css/tokens.css';
import '@styx/tokens/css/motion.css';
import './globals.css';
import { archivo, jetbrainsMono } from './fonts';
import { site } from '@/lib/site';
import { GTM_ID, consentDefaultsScript, gtmScript } from '@/lib/analytics';
import { Consent } from '@/components/Consent';
import { Tracking } from '@/components/Tracking';

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.title, template: '%s · Styx' },
  description: site.description,
  applicationName: site.name,
  keywords: [
    'AI coding agents',
    'Claude Code',
    'OpenAI Codex',
    'Gemini CLI',
    'Cursor agent',
    'Mac app for developers',
    'git worktrees',
    'AI agent production access',
    'agent approvals',
    'audit log',
  ],
  authors: [{ name: site.name, url: site.url }],
  creator: site.name,
  publisher: site.name,
  category: 'technology',
  openGraph: {
    title: site.tagline,
    description: site.shareDescription,
    type: 'website',
    siteName: site.name,
    locale: 'en_US',
    url: '/',
  },
  twitter: { card: 'summary_large_image', title: site.tagline, description: site.shareDescription },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
  },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'dark light',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: tokens.color.dark.bg },
    { media: '(prefers-color-scheme: light)', color: tokens.color.light.bg },
  ],
};

/** Resolves the theme before first paint: the saved choice, else the OS. Same attribute the app uses. */
const themeScript = `(function(){var t;try{t=localStorage.getItem('styx-theme')}catch(e){}if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${archivo.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {GTM_ID ? (
          <>
            {/* consent defaults must run before GTM, or tags fire ahead of the choice */}
            <script dangerouslySetInnerHTML={{ __html: consentDefaultsScript }} />
            <script dangerouslySetInnerHTML={{ __html: gtmScript(GTM_ID) }} />
          </>
        ) : null}
      </head>
      <body>
        {GTM_ID ? (
          <noscript>
            <iframe
              src={`https://www.googletagmanager.com/ns.html?id=${GTM_ID}`}
              height="0"
              width="0"
              style={{ display: 'none', visibility: 'hidden' }}
              title="Google Tag Manager"
            />
          </noscript>
        ) : null}
        {children}
        {GTM_ID ? <Tracking /> : null}
        <Consent />
      </body>
    </html>
  );
}
