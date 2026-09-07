import { colors, type Theme } from '@styx/tokens';

/** Structural copy of Monaco's `IStandaloneThemeData` so this module stays free of the Monaco import (testable in jsdom). */
export interface MonacoThemeData {
  base: 'vs' | 'vs-dark';
  inherit: boolean;
  rules: { token: string; foreground?: string; fontStyle?: string }[];
  colors: Record<string, string>;
}

export const monacoThemeName = (theme: Theme): string => `styx-${theme}`;

const hex = (value: string): string => value.replace(/^#/, '');

/** Fully transparent (8-digit hex; Monaco parses `#RRGGBBAA`). Used where a theme key must exist but draw nothing. */
export const TRANSPARENT = '#00000000';

/**
 * Syntax palette (handoff-discrepancies #58): three tones from the tokens, nothing else. Comments `--mu`;
 * strings, numbers and regexps `--act` (accent-as-text, safe on light); keywords, types, tags and attribute
 * names `--tx` bold; punctuation (`delimiter`, `operator`) `--mu`; everything else `--tx`. Token names are
 * Monaco's monarch conventions shared by every basic language; Monaco matches the longest dotted prefix, so
 * `string.key.json` (object keys) can stay `--tx` bold while `string` in general is `--act`.
 */
export const syntaxRules = (c: { tx: string; mu: string; act: string }): MonacoThemeData['rules'] => {
  const tx = hex(c.tx);
  const mu = hex(c.mu);
  const act = hex(c.act);
  const bold = (token: string) => ({ token, foreground: tx, fontStyle: 'bold' });
  const plain = (token: string, foreground: string) => ({ token, foreground });
  return [
    plain('', tx),
    // --mu
    plain('comment', mu),
    plain('comment.doc', mu),
    plain('delimiter', mu),
    plain('operator', mu),
    plain('operators', mu),
    plain('punctuation', mu),
    // --act
    plain('string', act),
    plain('string.escape', act),
    plain('string.value.json', act),
    plain('number', act),
    plain('number.hex', act),
    plain('number.float', act),
    plain('number.octal', act),
    plain('number.binary', act),
    plain('regexp', act),
    plain('regexp.escape', act),
    plain('attribute.value', act),
    plain('string.link', act),
    // --tx bold
    bold('keyword'),
    bold('keyword.flow'),
    bold('keyword.json'),
    bold('keyword.operator'),
    bold('keyword.other'),
    bold('storage'),
    bold('storage.type'),
    bold('type'),
    bold('type.identifier'),
    bold('tag'),
    bold('metatag'),
    bold('attribute.name'),
    bold('string.key.json'),
    bold('key'),
    bold('strong'),
    // --tx (explicit so language-specific names never fall through to a base theme)
    plain('identifier', tx),
    plain('variable', tx),
    plain('variable.predefined', tx),
    plain('constant', tx),
    plain('namespace', tx),
    plain('annotation', tx),
    plain('predefined', tx),
    plain('invalid', tx),
    plain('emphasis', tx),
    plain('metatag.content', tx),
    plain('white', tx),
  ];
};

/**
 * Editor theme from the tokens (plan §8 Tricky pieces): `--bg` surface, `--mu` line numbers, the three-tone
 * syntax palette above. Every widget Monaco can show (suggest, hover, context menu, go-to-line quick input,
 * find) is coloured here too, since `inherit: false` would otherwise leave VS Code's blues in place. Alpha
 * tokens (`--add`, `--dim`) are not theme colours; the hunk background comes from `.styx-hunk-line` CSS instead.
 */
export const monacoTheme = (theme: Theme): MonacoThemeData => {
  const c = colors[theme];
  return {
    base: theme === 'dark' ? 'vs-dark' : 'vs',
    inherit: false,
    rules: syntaxRules(c),
    colors: {
      // Surface
      'editor.background': c.bg,
      'editor.foreground': c.tx,
      foreground: c.tx,
      descriptionForeground: c.mu,
      disabledForeground: c.mu,
      'icon.foreground': c.mu,
      focusBorder: c.ac,
      'editorGutter.background': c.bg,
      'editorLineNumber.foreground': c.mu,
      'editorLineNumber.activeForeground': c.mu,
      'editorLineNumber.dimmedForeground': c.mu,
      'editorCursor.foreground': c.tx,
      'editorCursor.background': c.bg,
      'editor.selectionBackground': c.s2,
      'editor.inactiveSelectionBackground': c.s2,
      'editor.selectionHighlightBackground': c.s2,
      // Current line: a 1px `--ln` rule only (border width is trimmed from Monaco's 2px in MonacoEditor.module.css).
      'editor.lineHighlightBackground': TRANSPARENT,
      'editor.lineHighlightBorder': c.ln,
      'editor.rangeHighlightBackground': c.s2,
      'editor.rangeHighlightBorder': TRANSPARENT,
      'editor.symbolHighlightBackground': c.s2,
      'editor.hoverHighlightBackground': c.s2,
      'editor.findMatchBackground': c.s2,
      'editor.findMatchHighlightBackground': c.s2,
      'editor.findRangeHighlightBackground': c.s2,
      'editor.findMatchBorder': TRANSPARENT,
      'editor.findMatchHighlightBorder': TRANSPARENT,
      // Brackets (pair colourisation stays off; matching draws a `--ln` box)
      'editorBracketHighlight.foreground1': c.tx,
      'editorBracketHighlight.foreground2': c.tx,
      'editorBracketHighlight.foreground3': c.tx,
      'editorBracketHighlight.foreground4': c.tx,
      'editorBracketHighlight.foreground5': c.tx,
      'editorBracketHighlight.foreground6': c.tx,
      'editorBracketMatch.background': c.s2,
      'editorBracketMatch.border': c.ln,
      // Guides, whitespace, folding
      'editorIndentGuide.background': c.ln,
      'editorIndentGuide.activeBackground': c.ln,
      'editorIndentGuide.background1': c.ln,
      'editorIndentGuide.activeBackground1': c.ln,
      'editorWhitespace.foreground': c.ln,
      'editorRuler.foreground': c.ln,
      'editor.foldBackground': c.s2,
      'editor.foldPlaceholderForeground': c.mu,
      'editorGutter.foldingControlForeground': c.mu,
      // Links
      'editorLink.activeForeground': c.act,
      'textLink.foreground': c.act,
      'textLink.activeForeground': c.act,
      'textSeparator.foreground': c.ln,
      'textPreformat.foreground': c.tx,
      'textPreformat.background': c.s2,
      'textCodeBlock.background': c.s2,
      'textBlockQuote.background': c.s1,
      'textBlockQuote.border': c.ln,
      // Floating surfaces: `--s1` on a 1px `--tx` border, no shadow
      'editorWidget.background': c.s1,
      'editorWidget.foreground': c.tx,
      'editorWidget.border': c.tx,
      'editorWidget.resizeBorder': c.ln,
      'widget.shadow': TRANSPARENT,
      'widget.border': c.tx,
      'sash.hoverBorder': c.ln,
      'input.background': c.bg,
      'input.foreground': c.tx,
      'input.border': c.ln,
      'input.placeholderForeground': c.mu,
      'inputOption.activeBorder': c.ac,
      'inputOption.activeBackground': c.s2,
      'inputOption.activeForeground': c.tx,
      'inputOption.hoverBackground': c.s2,
      'button.background': c.ac,
      'button.foreground': c.acx,
      'button.hoverBackground': c.ac,
      'button.border': TRANSPARENT,
      'toolbar.hoverBackground': c.s2,
      'toolbar.activeBackground': c.s2,
      'badge.background': c.s2,
      'badge.foreground': c.tx,
      'progressBar.background': c.ac,
      // Suggest
      'editorSuggestWidget.background': c.s1,
      'editorSuggestWidget.border': c.tx,
      'editorSuggestWidget.foreground': c.tx,
      'editorSuggestWidget.selectedBackground': c.s2,
      'editorSuggestWidget.selectedForeground': c.tx,
      'editorSuggestWidget.selectedIconForeground': c.tx,
      'editorSuggestWidget.highlightForeground': c.act,
      'editorSuggestWidget.focusHighlightForeground': c.act,
      'editorSuggestWidgetStatus.foreground': c.mu,
      // Hover
      'editorHoverWidget.background': c.s1,
      'editorHoverWidget.foreground': c.tx,
      'editorHoverWidget.border': c.tx,
      'editorHoverWidget.statusBarBackground': c.s2,
      'editorHoverWidget.highlightForeground': c.act,
      // Context menu
      'menu.background': c.s1,
      'menu.foreground': c.tx,
      'menu.border': c.tx,
      'menu.selectionBackground': c.s2,
      'menu.selectionForeground': c.tx,
      'menu.selectionBorder': TRANSPARENT,
      'menu.separatorBackground': c.ln,
      'keybindingLabel.background': TRANSPARENT,
      'keybindingLabel.foreground': c.mu,
      'keybindingLabel.border': TRANSPARENT,
      'keybindingLabel.bottomBorder': TRANSPARENT,
      // Go to line (quick input) + lists
      'quickInput.background': c.s1,
      'quickInput.foreground': c.tx,
      'quickInputTitle.background': c.s2,
      'quickInputList.focusBackground': c.s2,
      'quickInputList.focusForeground': c.tx,
      'quickInputList.focusIconForeground': c.tx,
      'pickerGroup.foreground': c.mu,
      'pickerGroup.border': c.ln,
      'list.focusBackground': c.s2,
      'list.focusForeground': c.tx,
      'list.focusOutline': TRANSPARENT,
      'list.inactiveFocusOutline': TRANSPARENT,
      'list.activeSelectionBackground': c.s2,
      'list.activeSelectionForeground': c.tx,
      'list.inactiveSelectionBackground': c.s2,
      'list.inactiveSelectionForeground': c.tx,
      'list.hoverBackground': c.s2,
      'list.hoverForeground': c.tx,
      'list.highlightForeground': c.act,
      'list.focusHighlightForeground': c.act,
      // Scrollbars
      'scrollbar.shadow': TRANSPARENT,
      'scrollbarSlider.background': c.ln,
      'scrollbarSlider.hoverBackground': c.mu,
      'scrollbarSlider.activeBackground': c.mu,
    },
  };
};

/**
 * Language ids by lowercase extension. Every id is a Monaco basic language (`languages/definitions/*`) or `json`
 * (`languages/features/json`); `plaintext` stays for anything Monaco has no tokenizer for (toml, prisma, makefile).
 */
export const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  webmanifest: 'json',
  har: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  vue: 'html',
  svelte: 'html',
  astro: 'html',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  fish: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  properties: 'ini',
  editorconfig: 'ini',
  gitconfig: 'ini',
  sql: 'sql',
  mysql: 'mysql',
  pgsql: 'pgsql',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  php: 'php',
  phtml: 'php',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  csx: 'csharp',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  graphql: 'graphql',
  gql: 'graphql',
  xml: 'xml',
  svg: 'xml',
  xsl: 'xml',
  xsd: 'xml',
  plist: 'xml',
  csproj: 'xml',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  hbs: 'handlebars',
  handlebars: 'handlebars',
  dockerfile: 'dockerfile',
  bat: 'bat',
  cmd: 'bat',
  scala: 'scala',
  sc: 'scala',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  edn: 'clojure',
  coffee: 'coffee',
  ex: 'elixir',
  exs: 'elixir',
  fs: 'fsharp',
  fsx: 'fsharp',
  fsi: 'fsharp',
  hcl: 'hcl',
  tf: 'hcl',
  tfvars: 'hcl',
  jl: 'julia',
  m: 'objective-c',
  mm: 'objective-c',
  pas: 'pascal',
  pl: 'perl',
  pm: 'perl',
  proto: 'protobuf',
  pug: 'pug',
  jade: 'pug',
  twig: 'twig',
  vb: 'vb',
  wgsl: 'wgsl',
  tcl: 'tcl',
  sol: 'solidity',
  rst: 'restructuredtext',
  liquid: 'liquid',
  cshtml: 'razor',
  razor: 'razor',
  scm: 'scheme',
  ss: 'scheme',
  rkt: 'scheme',
  bicep: 'bicep',
  tsp: 'typespec',
  cypher: 'cypher',
  cyp: 'cypher',
  sparql: 'sparql',
  rq: 'sparql',
  sv: 'systemverilog',
  svh: 'systemverilog',
  v: 'systemverilog',
  dax: 'msdax',
  pq: 'powerquery',
  qs: 'qsharp',
  ftl: 'freemarker2',
  mligo: 'cameligo',
  ligo: 'pascaligo',
  dats: 'postiats',
  abap: 'abap',
  cls: 'apex',
  azcli: 'azcli',
  ecl: 'ecl',
  flow: 'flow9',
  lex: 'lexon',
  m3: 'm3',
  mips: 'mips',
  pla: 'pla',
  redis: 'redis',
  st: 'st',
  sb: 'sb',
  aes: 'sophia',
  csp: 'csp',
};

/** Well-known extension-less (or dot-) filenames, matched on the lowercase basename. */
export const LANGUAGE_BY_FILENAME: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  '.env': 'ini',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.gitmodules': 'ini',
  '.dockerignore': 'ini',
  '.npmrc': 'ini',
  '.yarnrc': 'ini',
  '.editorconfig': 'ini',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.zshrc': 'shell',
  '.zprofile': 'shell',
  '.profile': 'shell',
  '.babelrc': 'json',
  '.eslintrc': 'json',
  '.prettierrc': 'json',
  '.swcrc': 'json',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  brewfile: 'ruby',
  vagrantfile: 'ruby',
  makefile: 'plaintext',
  'cmakelists.txt': 'plaintext',
};

const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).toLowerCase();

/** Language id from a file path (highlighting only; ADR-0002: no language service). */
export const languageOf = (path: string): string => {
  const name = basenameOf(path);
  const byName = LANGUAGE_BY_FILENAME[name];
  if (byName !== undefined) return byName;
  // `.env.local`, `.env.production` → ini; `Dockerfile.dev` → dockerfile.
  if (name.startsWith('.env.')) return 'ini';
  if (name.startsWith('dockerfile.')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'plaintext';
  return LANGUAGE_BY_EXT[name.slice(dot + 1)] ?? 'plaintext';
};

/**
 * Status-bar language label ("TS", "JSON"): the extension, upper-cased; extension-less files read as their
 * language ("DOCKERFILE") or "TXT" when Monaco has none.
 */
export const languageLabelOf = (path: string): string => {
  const name = basenameOf(path);
  const dot = name.lastIndexOf('.');
  if (dot > 0) return name.slice(dot + 1).toUpperCase();
  const lang = languageOf(path);
  return lang === 'plaintext' ? 'TXT' : lang.toUpperCase();
};
