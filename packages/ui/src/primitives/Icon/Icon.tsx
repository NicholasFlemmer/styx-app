import type { SVGAttributes } from 'react';

/** Chrome glyphs drawn as SVG so mac and win render identically: ▾ ✕ ⤢ ─ ☐ ⌄. Text glyphs (⏎ ⌘ ⇧ ● ■ ◆ ▲ ✓ → ↑ ↓) stay text. */
export type IconName = 'chevron' | 'close' | 'popout' | 'minimize' | 'maximize' | 'plus';

const PATHS: Record<IconName, { d: string; box: number; fill?: boolean }> = {
  chevron: { d: 'M2 4.5 L6 8.5 L10 4.5 Z', box: 12, fill: true },
  close: { d: 'M3 3 L11 11 M11 3 L3 11', box: 14 },
  popout: { d: 'M8 2 H12 V6 M12 2 L7 7 M6 12 H2 V8 M2 12 L7 7', box: 14 },
  minimize: { d: 'M2 7 H12', box: 14 },
  maximize: { d: 'M3 3 H11 V11 H3 Z', box: 14 },
  plus: { d: 'M7 2 V12 M2 7 H12', box: 14 },
};

export interface IconProps extends Omit<SVGAttributes<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Rendered size in px (defaults to the glyph's native box: chevron 12, others 14). */
  size?: number;
}

export function Icon({ name, size, className, ...rest }: IconProps) {
  const p = PATHS[name];
  const px = size ?? p.box;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={px}
      height={px}
      viewBox={`0 0 ${p.box} ${p.box}`}
      className={className}
      {...rest}
    >
      <path d={p.d} fill={p.fill ? 'currentColor' : 'none'} stroke={p.fill ? 'none' : 'currentColor'} strokeWidth={1} shapeRendering="crispEdges" />
    </svg>
  );
}
