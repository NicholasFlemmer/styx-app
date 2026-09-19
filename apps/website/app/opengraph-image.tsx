import { ImageResponse } from 'next/og';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import tokens from '@styx/tokens/tokens.json';
import { site } from '@/lib/site';

export const dynamic = 'force-static';
export const alt = site.title;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** pnpm hoists @fontsource to whichever node_modules wins; walk up from the app until the files exist. */
const fontDir = (pkg: string): string => {
  let dir = process.cwd();
  for (let i = 0; i < 4; i += 1) {
    const candidate = join(dir, 'node_modules', '@fontsource', pkg, 'files');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`@fontsource/${pkg} is not installed`);
};
const fontFile = (pkg: string, file: string) => readFile(join(fontDir(pkg), file));

export default async function Image() {
  const [archivo600, mono400] = await Promise.all([
    fontFile('archivo', 'archivo-latin-600-normal.woff'),
    fontFile('jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff'),
  ]);
  const c = tokens.color.dark;
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: c.bg,
          color: c.text,
          fontFamily: 'Archivo',
          padding: 64,
          borderTop: `1px solid ${c.line}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 22, letterSpacing: '0.22em' }}>
          <span>STYX</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'JetBrains Mono', fontSize: 20, letterSpacing: 0, color: c.muted }}>
            <div style={{ width: 12, height: 12, background: c.accent }} />
            <span>01 NEEDS YOU</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 'auto' }}>
          <div style={{ fontSize: 76, lineHeight: 1.02, letterSpacing: '-0.03em', maxWidth: 1000 }}>
            Every project. Every agent. Every key. One window.
          </div>
          <div style={{ marginTop: 36, fontFamily: 'JetBrains Mono', fontSize: 22, color: c.muted }}>
            Nothing crosses into production without you.
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Archivo', data: archivo600, style: 'normal', weight: 600 },
        { name: 'JetBrains Mono', data: mono400, style: 'normal', weight: 400 },
      ],
    },
  );
}
