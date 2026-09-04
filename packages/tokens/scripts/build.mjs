// Generates css/tokens.css, css/fonts.css, css/motion.css, src/generated.ts and copies bundled fonts.
// The colour block of css/tokens.css must stay byte-identical in values to design/handoff/styx-tokens.css.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);
const tokens = JSON.parse(readFileSync(join(root, 'tokens.json'), 'utf8'));

const short = {
  page: 'page',
  bg: 'bg',
  surface1: 's1',
  surface2: 's2',
  line: 'ln',
  text: 'tx',
  muted: 'mu',
  accent: 'ac',
  accentInk: 'acx',
  accentText: 'act',
  diffAdd: 'add',
  terminal: 'term',
  terminalText: 'termtx',
  dim: 'dim',
};
const vars = (theme) =>
  Object.entries(short)
    .map(([k, v]) => `--${v}:${tokens.color[theme][k].replace(/0\./g, '.').replace(/,\s*/g, ',')}`)
    .join('; ') + ';';

// Terminal ANSI palette (not in the handoff; monochrome-leaning, accent for green/yellow).
const ansi = {
  dark: {
    black: '#0d0e0c',
    red: '#ff6b5b',
    green: '#d6ff3d',
    yellow: '#e9ebe3',
    blue: '#9fb3ff',
    magenta: '#e0a0ff',
    cyan: '#8fe3d8',
    white: '#c9cdc2',
    brightBlack: '#585c54',
    brightRed: '#ff8a7d',
    brightGreen: '#e4ff7a',
    brightYellow: '#ffffff',
    brightBlue: '#c0ccff',
    brightMagenta: '#efc6ff',
    brightCyan: '#b4f0e9',
    brightWhite: '#e9ebe3',
  },
  light: {
    black: '#14160f',
    red: '#b3261e',
    green: '#4f6b00',
    yellow: '#5d6259',
    blue: '#2b4fb3',
    magenta: '#7a3fb3',
    cyan: '#1f7a70',
    white: '#d5d8cc',
    brightBlack: '#5d6259',
    brightRed: '#d43b31',
    brightGreen: '#6e8f00',
    brightYellow: '#14160f',
    brightBlue: '#3d63d1',
    brightMagenta: '#9455cc',
    brightCyan: '#2a9a8e',
    brightWhite: '#ffffff',
  },
};

const css = `/* Styx design tokens — generated from tokens.json by scripts/build.mjs. Do not edit. */
@layer tokens {
  :root, [data-theme="dark"] {
    ${vars('dark')}
  }
  [data-theme="light"] {
    ${vars('light')}
  }
  :root {
    --font-ui: 'Archivo', system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', ui-monospace, monospace;
    --label: 600 10px/1 var(--font-ui); --label-tracking: .1em;
    --body: 400 13px/1.5 var(--font-ui);
    --code: 400 12.5px/1.75 var(--font-mono);
    --numeral-lg: 600 56px/1 var(--font-ui); --numeral-md: 600 28px/1 var(--font-ui);
    --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px; --sp-8:32px; --sp-10:40px;
    --h-titlebar:${tokens.size.titlebar}px; --w-rail:${tokens.size.rail}px; --w-nav:${tokens.size.nav}px; --w-files:${tokens.size.filesPane}px; --w-chat:${tokens.size.chatPane}px; --w-sheet:${tokens.size.sheet}px; --w-drawer:${tokens.size.auditDrawer}px;
    --w-policies:${tokens.size.policiesPane}px; --w-settings-nav:${tokens.size.settingsNav}px; --h-tabrow:${tokens.size.tabRow}px; --h-hunkbar:${tokens.size.hunkBar}px; --h-terminal:${tokens.size.terminal}px; --h-statusbar:${tokens.size.statusBar}px;
    --w-palette:${tokens.size.palette}px; --w-modal-connect:${tokens.size.modalConnect}px; --w-modal-spawn:${tokens.size.modalSpawn}px; --w-toast:${tokens.size.toast}px;
    --radius:0; --shadow:none;
    --border:1px solid var(--ln); --border-strong:1px solid var(--tx);
    --motion-sheet:160ms; --motion-modal:120ms; --motion-toast:160ms; --ease-sheet:cubic-bezier(.2,.8,.2,1);
  }
}
`;
writeFileSync(join(root, 'css', 'tokens.css'), css);

const motion = `/* Motion keyframes (spec §2). Reduced motion → fades only. */
@layer tokens {
  @keyframes styx-sheet-in { from { transform: translateX(100%); } to { transform: translateX(0); } }
  @keyframes styx-modal-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes styx-toast-in { from { transform: translateY(-8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes styx-blink { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    @keyframes styx-sheet-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes styx-toast-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes styx-blink { from { opacity: 1; } to { opacity: 1; } }
  }
}
`;
writeFileSync(join(root, 'css', 'motion.css'), motion);

// Fonts: copy woff2 from @fontsource packages (latin + latin-ext) so nothing is fetched at runtime.
const fontFiles = [];
const copyFont = (pkg, file) => {
  const src = join(dirname(require.resolve(`${pkg}/package.json`)), 'files', file);
  if (!existsSync(src)) throw new Error(`missing font ${src}`);
  mkdirSync(join(root, 'fonts'), { recursive: true });
  copyFileSync(src, join(root, 'fonts', file));
  fontFiles.push(file);
};
const faces = [];
for (const w of tokens.font.ui.weights)
  for (const sub of ['latin', 'latin-ext']) {
    const f = `archivo-${sub}-${w}-normal.woff2`;
    copyFont('@fontsource/archivo', f);
    faces.push(['Archivo', w, f, sub]);
  }
for (const w of tokens.font.mono.weights)
  for (const sub of ['latin', 'latin-ext']) {
    const f = `jetbrains-mono-${sub}-${w}-normal.woff2`;
    copyFont('@fontsource/jetbrains-mono', f);
    faces.push(['JetBrains Mono', w, f, sub]);
  }
const ranges = {
  latin:
    'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  'latin-ext':
    'U+0100-02AF, U+0304, U+0308, U+0329, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20CF, U+2113, U+2C60-2C7F, U+A720-A7FF',
};
const fontsCss =
  `/* Bundled fonts (generated). */\n` +
  faces
    .map(
      ([fam, w, f, sub]) =>
        `@font-face { font-family: '${fam}'; font-style: normal; font-weight: ${w}; font-display: block; src: url('../fonts/${f}') format('woff2'); unicode-range: ${ranges[sub]}; }`,
    )
    .join('\n') +
  '\n';
writeFileSync(join(root, 'css', 'fonts.css'), fontsCss);

const ts = `// Generated from tokens.json by scripts/build.mjs. Do not edit.
export const colors = ${JSON.stringify({ dark: Object.fromEntries(Object.entries(short).map(([k, v]) => [v, tokens.color.dark[k]])), light: Object.fromEntries(Object.entries(short).map(([k, v]) => [v, tokens.color.light[k]])) }, null, 2)} as const;
export const terminalAnsi = ${JSON.stringify(ansi, null, 2)} as const;
export const sizes = ${JSON.stringify({ ...tokens.size, modalNewProject: 600, footerButton: 44, modalTop: 90, paletteTop: 110, diffFilesPane: 220 }, null, 2)} as const;
export const space = ${JSON.stringify(tokens.space)} as const;
export const motion = { sheet: 160, modal: 120, toast: 160, toastTtl: 8000, blink: 1000 } as const;
export const shortcuts = ${JSON.stringify({ ...tokens.shortcuts, focusAgent: ['Mod+1', 'Mod+2', 'Mod+3', 'Mod+4'] }, null, 2)} as const;
export const fonts = { ui: 'Archivo', mono: 'JetBrains Mono', files: ${JSON.stringify(fontFiles)} } as const;
`;
writeFileSync(join(root, 'src', 'generated.ts'), ts);
console.log('tokens built:', fontFiles.length, 'font files');
