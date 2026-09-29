import { ImageResponse } from 'next/og';
import tokens from '@styx/tokens/tokens.json';

export const dynamic = 'force-static';
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/** The home-screen / bookmark icon and the logo in structured data: icon.svg's nested squares, as a PNG. */
export default function AppleIcon() {
  const c = tokens.color.dark;
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: c.accent,
      }}
    >
      <div
        style={{
          width: 101,
          height: 101,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: c.bg,
        }}
      >
        <div style={{ width: 45, height: 45, background: c.accent }} />
      </div>
    </div>,
    size,
  );
}
