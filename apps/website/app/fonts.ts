import localFont from 'next/font/local';

/** The app's bundled faces, served from @styx/tokens so the site and the app render the same glyphs. */
export const archivo = localFont({
  src: [
    { path: '../../../packages/tokens/fonts/archivo-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../../packages/tokens/fonts/archivo-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: '../../../packages/tokens/fonts/archivo-latin-600-normal.woff2', weight: '600', style: 'normal' },
    { path: '../../../packages/tokens/fonts/archivo-latin-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-archivo',
  display: 'swap',
  fallback: ['system-ui', 'sans-serif'],
});

export const jetbrainsMono = localFont({
  src: [
    { path: '../../../packages/tokens/fonts/jetbrains-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../../../packages/tokens/fonts/jetbrains-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-jetbrains',
  display: 'swap',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
});
