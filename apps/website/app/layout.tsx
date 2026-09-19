import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import tokens from '@styx/tokens/tokens.json';
import '@styx/tokens/css/tokens.css';
import '@styx/tokens/css/motion.css';
import './globals.css';
import { archivo, jetbrainsMono } from './fonts';
import { site } from '@/lib/site';

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.title, template: '%s · Styx' },
  description: site.description,
  applicationName: site.name,
  keywords: ['coding agents', 'Claude Code', 'Codex', 'Gemini CLI', 'Cursor', 'git worktrees', 'deploy grants', 'audit log', 'desktop app'],
  openGraph: { title: site.title, description: site.description, type: 'website', siteName: site.name, url: '/' },
  twitter: { card: 'summary_large_image', title: site.title, description: site.description },
  robots: { index: true, follow: true },
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
    <html lang="en" data-theme="dark" className={`${archivo.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
