import { z } from 'zod';

/**
 * Designs (owner request, discrepancy #140): screens an agent draws before anything is built, kept as files in the
 * task's worktree so they are reviewed, kept and landed like any other work.
 *
 *   .styx/designs/tokens.json              colours, typefaces, type scale, corners, spacing (Type and colour)
 *   .styx/designs/tokens.css               the same as CSS variables, written by Styx; every screen links it
 *   .styx/designs/<screen>/<size>.html     one screen at one size, high fidelity
 *   .styx/designs/<screen>/<size>.wire.html  the same screen as a wireframe
 */
export const DESIGN_DIR = '.styx/designs';

export const designSizeSchema = z.enum(['desktop', 'tablet', 'phone']);
export type DesignSize = z.infer<typeof designSizeSchema>;
export const DESIGN_SIZES: readonly DesignSize[] = ['desktop', 'tablet', 'phone'];
/** The width each size is drawn at (CSS pixels). */
export const DESIGN_WIDTH: Record<DesignSize, number> = { desktop: 1280, tablet: 834, phone: 390 };

export const designFidelitySchema = z.enum(['wire', 'hi']);
export type DesignFidelity = z.infer<typeof designFidelitySchema>;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const designTokensSchema = z.object({
  colors: z
    .array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), value: hex }))
    .max(24),
  fonts: z.object({ heading: z.string().min(1).max(80), body: z.string().min(1).max(80) }),
  scale: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        size: z.number().int().min(8).max(160),
        line: z.number().int().min(8).max(200),
        weight: z.number().int().min(100).max(900),
      }),
    )
    .max(10),
  radius: z.number().int().min(0).max(64),
  spacing: z.number().int().min(1).max(32),
});
export type DesignTokens = z.infer<typeof designTokensSchema>;

/** Where a design starts before the agent or the person sets its own. */
export const DEFAULT_DESIGN_TOKENS: DesignTokens = {
  colors: [
    { name: 'primary', value: '#2F5BFF' },
    { name: 'ink', value: '#141A2B' },
    { name: 'muted', value: '#6A7184' },
    { name: 'surface', value: '#FFFFFF' },
    { name: 'tint', value: '#EEF1FF' },
    { name: 'success', value: '#16A34A' },
  ],
  fonts: { heading: 'system-ui', body: 'system-ui' },
  scale: [
    { name: 'display', size: 28, line: 34, weight: 750 },
    { name: 'heading', size: 18, line: 24, weight: 700 },
    { name: 'body', size: 14, line: 20, weight: 400 },
    { name: 'caption', size: 12, line: 16, weight: 400 },
  ],
  radius: 8,
  spacing: 4,
};

export const designFileSchema = z.object({
  /** Relative to `DESIGN_DIR`, e.g. `checkout/phone.wire.html`. */
  path: z.string().min(1),
  screen: z.string().min(1),
  size: designSizeSchema,
  fidelity: designFidelitySchema,
  mtime: z.number(),
});
export type DesignFile = z.infer<typeof designFileSchema>;

export const designScreenSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  files: z.array(designFileSchema),
});
export type DesignScreen = z.infer<typeof designScreenSchema>;

export const designListSchema = z.object({
  /** The worktree the design lives in (a build task's linked design lives in its design task's worktree). */
  worktreeId: z.string(),
  screens: z.array(designScreenSchema),
  tokens: designTokensSchema.nullable(),
});
export type DesignList = z.infer<typeof designListSchema>;

const PATH_RE = /^([a-z0-9][a-z0-9-]{0,63})\/(desktop|tablet|phone)(\.wire)?\.html$/;

/** A screen file's place in the design, or null for anything that is not one (tokens, notes, images). */
export const parseDesignPath = (
  path: string,
): { screen: string; size: DesignSize; fidelity: DesignFidelity } | null => {
  const m = PATH_RE.exec(path);
  if (m === null) return null;
  const size = DESIGN_SIZES.find((s) => s === m[2]);
  if (m[1] === undefined || size === undefined) return null;
  return { screen: m[1], size, fidelity: m[3] === undefined ? 'hi' : 'wire' };
};

/** `checkout` → "Checkout", `order-history` → "Order history". */
export const screenName = (slug: string): string => {
  const words = slug.replace(/-/g, ' ').trim();
  return words === '' ? slug : words.charAt(0).toUpperCase() + words.slice(1);
};

/** Files into screens, in the order the agent's names sort, each screen's files by size then fidelity. */
export const designScreens = (files: readonly DesignFile[]): DesignScreen[] => {
  const by = new Map<string, DesignFile[]>();
  for (const f of files) by.set(f.screen, [...(by.get(f.screen) ?? []), f]);
  return [...by.keys()].sort().map((slug) => ({
    slug,
    name: screenName(slug),
    files: (by.get(slug) ?? []).sort(
      (a, b) =>
        DESIGN_SIZES.indexOf(a.size) - DESIGN_SIZES.indexOf(b.size) ||
        (a.fidelity === b.fidelity ? 0 : a.fidelity === 'hi' ? -1 : 1),
    ),
  }));
};

/** The design's tokens as CSS variables, for `tokens.css`: `--color-<name>`, `--font-*`, `--text-<name>-*`, … */
export const tokensCss = (t: DesignTokens): string => {
  const lines = [
    ...t.colors.map((c) => `  --color-${c.name}: ${c.value};`),
    `  --font-heading: ${cssFont(t.fonts.heading)};`,
    `  --font-body: ${cssFont(t.fonts.body)};`,
    ...t.scale.flatMap((s) => [
      `  --text-${s.name}-size: ${s.size}px;`,
      `  --text-${s.name}-line: ${s.line}px;`,
      `  --text-${s.name}-weight: ${s.weight};`,
    ]),
    `  --radius: ${t.radius}px;`,
    `  --space: ${t.spacing}px;`,
  ];
  return `/* Written by Styx from tokens.json; edit Type and colour in the Design tab, or tokens.json. */\n:root {\n${lines.join('\n')}\n}\n`;
};

const cssFont = (name: string): string => {
  const clean = name.replace(/[^A-Za-z0-9 \-]/g, '').trim();
  if (clean === '' || clean === 'system-ui') return 'system-ui, -apple-system, sans-serif';
  return `"${clean}", system-ui, -apple-system, sans-serif`;
};
