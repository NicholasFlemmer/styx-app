import type { SVGAttributes } from 'react';

/**
 * Chrome glyphs drawn as SVG so mac and win render identically: ▾ ✕ ⤢ ─ ☐ ⌄, plus the navigation set for the
 * app rail and the project nav (owner request, discrepancy #87). Text glyphs (⏎ ⌘ ⇧ ● ■ ◆ ▲ ✓ → ↑ ↓) stay text.
 *
 * Drawing rules (the Styx look): a 16px grid for navigation icons, 1px strokes on half-pixel coordinates with
 * `crispEdges`, square joins, straight lines only (no arcs), filled squares for emphasis. Every icon reads at 16px
 * inside a 36px tile and at 14px beside a nav label.
 */
export type IconName =
  | 'chevron'
  | 'close'
  | 'popout'
  | 'minimize'
  | 'maximize'
  | 'plus'
  // app rail
  | 'projects'
  | 'agents'
  | 'approvals'
  | 'tasks'
  | 'general'
  | 'editor'
  | 'connections'
  | 'skills'
  | 'keychain'
  | 'policies'
  | 'shortcuts'
  // project nav
  | 'workspace'
  | 'repo'
  | 'projectSettings'
  | 'targets'
  | 'agentDefaults'
  | 'env'
  | 'audit';

interface Part {
  d: string;
  fill?: boolean;
}
interface Glyph {
  box: number;
  parts: Part[];
}

const stroke = (d: string): Part => ({ d });
const solid = (d: string): Part => ({ d, fill: true });
/** A filled square with its top-left corner at (x, y) and side `s`. */
const square = (x: number, y: number, s: number): Part => solid(`M${x} ${y} H${x + s} V${y + s} H${x} Z`);

const GLYPHS: Record<IconName, Glyph> = {
  chevron: { box: 12, parts: [solid('M2 4.5 L6 8.5 L10 4.5 Z')] },
  close: { box: 14, parts: [stroke('M3 3 L11 11 M11 3 L3 11')] },
  popout: { box: 14, parts: [stroke('M8 2 H12 V6 M12 2 L7 7 M6 12 H2 V8 M2 12 L7 7')] },
  minimize: { box: 14, parts: [stroke('M2 7 H12')] },
  maximize: { box: 14, parts: [stroke('M3 3 H11 V11 H3 Z')] },
  plus: { box: 14, parts: [stroke('M7 2 V12 M2 7 H12')] },

  /** All projects: a 2×2 of tiles, the rail's own shape. */
  projects: {
    box: 16,
    parts: [stroke('M2.5 2.5 H7 V7 H2.5 Z M9 2.5 H13.5 V7 H9 Z M2.5 9 H7 V13.5 H2.5 Z'), square(9, 9, 4.5)],
  },
  /** Agents: a terminal prompt in a window. */
  agents: {
    box: 16,
    parts: [stroke('M1.5 2.5 H14.5 V13.5 H1.5 Z M1.5 5.5 H14.5 M4 8 L6 10 L4 12 M8 12 H11.5')],
  },
  /** Approvals: the grant diamond (◆ in the palette) with a tick. */
  approvals: { box: 16, parts: [stroke('M8 1.5 L14.5 8 L8 14.5 L1.5 8 Z M5.5 8 L7.5 10 L10.5 6.5')] },
  /** Tasks: a window with a play marker. */
  tasks: { box: 16, parts: [stroke('M1.5 2.5 H14.5 V13.5 H1.5 Z'), solid('M6 5.5 L11 8 L6 10.5 Z')] },
  /** General: three sliders. */
  general: {
    box: 16,
    parts: [
      stroke('M1.5 4.5 H14.5 M1.5 8.5 H14.5 M1.5 12.5 H14.5'),
      square(4, 3, 3),
      square(9, 7, 3),
      square(6, 11, 3),
    ],
  },
  /** Editor: code brackets. */
  editor: {
    box: 16,
    parts: [stroke('M5.5 3.5 L1.5 8 L5.5 12.5 M10.5 3.5 L14.5 8 L10.5 12.5 M9.5 2 L6.5 14')],
  },
  /** Agent connections: two ends joined. */
  connections: {
    box: 16,
    parts: [
      stroke('M1.5 5.5 H6 V10.5 H1.5 Z M10 5.5 H14.5 V10.5 H10 Z M6 8 H10'),
      square(3, 7, 2),
      square(11, 7, 2),
    ],
  },
  /** Skills: a bolt. */
  skills: { box: 16, parts: [solid('M9.5 1 L3 9 H7.5 L6.5 15 L13 7 H8.5 Z')] },
  /** Keychain & secrets: a key. */
  keychain: {
    box: 16,
    parts: [stroke('M1.5 5.5 H6.5 V10.5 H1.5 Z M6.5 8 H14.5 M11.5 8 V11 M14.5 8 V10.5'), square(3, 7, 2)],
  },
  /** Policies: a document with rules. */
  policies: {
    box: 16,
    parts: [stroke('M3.5 1.5 H10.5 L13.5 4.5 V14.5 H3.5 Z M10.5 1.5 V4.5 H13.5 M6 8 H11 M6 11 H11')],
  },
  /** Shortcuts: a keyboard. */
  shortcuts: {
    box: 16,
    parts: [
      stroke('M1.5 4.5 H14.5 V11.5 H1.5 Z'),
      square(3, 6, 2),
      square(7, 6, 2),
      square(11, 6, 2),
      stroke('M5 9.5 H11'),
    ],
  },

  /** Workspace: the three-pane window. */
  workspace: { box: 16, parts: [stroke('M1.5 2.5 H14.5 V13.5 H1.5 Z M6 2.5 V13.5 M6 8.5 H14.5')] },
  /** Repo: a branch fork with square commits. */
  repo: {
    box: 16,
    parts: [
      stroke('M4 4 V13 M4 9.5 H12 M12 7 V9.5'),
      square(2.5, 1.5, 3),
      square(10.5, 4, 3),
      square(2.5, 12, 3),
    ],
  },
  /** Project settings: a folder with a slider. */
  projectSettings: {
    box: 16,
    parts: [stroke('M1.5 3.5 H6 L7.5 5.5 H14.5 V13.5 H1.5 Z M4 9.5 H12'), square(8, 8, 3)],
  },
  /** Targets: concentric squares (where a deploy lands). */
  targets: {
    box: 16,
    parts: [stroke('M1.5 1.5 H14.5 V14.5 H1.5 Z M4.5 4.5 H11.5 V11.5 H4.5 Z'), square(7, 7, 2)],
  },
  /** Agent defaults: a terminal window with its slider. */
  agentDefaults: {
    box: 16,
    parts: [stroke('M1.5 2.5 H14.5 V10.5 H1.5 Z M4 5 L6 7 L4 9 M3 13.5 H13'), square(7, 12, 3)],
  },
  /** Env & secrets: key = value rows. */
  env: {
    box: 16,
    parts: [
      stroke('M2 4 H5.5 M8 4 H14 M2 8 H5.5 M8 8 H14 M2 12 H5.5 M8 12 H14'),
      square(6, 3, 1.5),
      square(6, 7, 1.5),
      square(6, 11, 1.5),
    ],
  },
  /** Tech debt audit: a magnifier over a page. */
  audit: {
    box: 16,
    parts: [stroke('M2.5 2.5 H9.5 V9.5 H2.5 Z M9.5 9.5 L14 14 M4.5 5 H7.5 M4.5 7 H7.5')],
  },
};

export interface IconProps extends Omit<SVGAttributes<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Rendered size in px (defaults to the glyph's native box: chevron 12, chrome 14, navigation 16). */
  size?: number;
}

export function Icon({ name, size, className, ...rest }: IconProps) {
  const g = GLYPHS[name];
  const px = size ?? g.box;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={px}
      height={px}
      viewBox={`0 0 ${g.box} ${g.box}`}
      className={className}
      {...rest}
    >
      {g.parts.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill ? 'currentColor' : 'none'}
          stroke={p.fill ? 'none' : 'currentColor'}
          strokeWidth={1}
          strokeLinejoin="miter"
          strokeLinecap="square"
          shapeRendering="crispEdges"
        />
      ))}
    </svg>
  );
}

/** Every icon name, for the story matrix and tests. */
export const ICON_NAMES = Object.keys(GLYPHS) as IconName[];
