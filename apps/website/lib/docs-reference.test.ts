/**
 * Drift guard for the Reference docs (content/docs/reference).
 *
 * Those pages promise to be complete: every MCP tool, every STYX_* variable, every keyboard shortcut, every
 * project.json field. That promise breaks silently the day someone adds a tool or a variable and forgets the docs,
 * so these tests read the source of truth as text (no imports from the desktop app or the packages: the website
 * must build on its own) and fail when a page and the code disagree.
 *
 * When one fails: update the page in content/docs/reference, not the test, unless the extraction itself is wrong.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const page = (slug: string): string => read(`apps/website/content/docs/reference/${slug}.mdx`);

/** Every non-test .ts / .tsx file under `dir` (relative to the repo root). */
const sourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      if (name === 'node_modules' || name === 'dist' || name === 'out') continue;
      const p = join(abs, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.(test|spec|stories)\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
        out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, dir));
  return out;
};

const uniq = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

describe('reference: MCP tools', () => {
  // `server.registerTool('name', …)` in the stdio server is the list agents actually see.
  const tools = uniq(
    [...read('packages/broker/src/mcp-stdio.ts').matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map(
      (m) => m[1] ?? '',
    ),
  );
  // One `### name` heading per tool.
  const headings = uniq([...page('mcp-tools').matchAll(/^###\s+`?([a-z_]+)`?\s*$/gm)].map((m) => m[1] ?? ''));

  it('finds the tools in the source', () => {
    expect(tools.length).toBeGreaterThanOrEqual(10);
    expect(tools).toContain('request_access');
  });

  it('documents exactly the registered tools, one heading each', () => {
    expect(headings).toEqual(tools);
  });
});

describe('reference: environment variables', () => {
  const files = [
    ...sourceFiles('apps/desktop/src'),
    ...sourceFiles('packages/cli/src'),
    ...sourceFiles('packages/broker/src'),
  ];
  const sources = files.map((f) => read(f)).join('\n');
  const doc = page('environment-variables');

  // A read is `env['STYX_X']`, `env.STYX_X`, `process.env['STYX_X']`, `e['STYX_X']` (the preload's copy of the
  // env), or `…env.STYX_X` — but not an assignment (`env['STYX_X'] = …`, which only sets a variable for a child).
  const READ = /\b(?:env|e)\s*(?:\[\s*['"](STYX_[A-Z0-9_]+)['"]\s*\]|\.(STYX_[A-Z0-9_]+)\b)(?!\s*=(?!=))/g;
  const reads = uniq([...sources.matchAll(READ)].map((m) => m[1] ?? m[2] ?? ''));
  const documented = uniq([...doc.matchAll(/\bSTYX_[A-Z0-9_]*[A-Z0-9]\b/g)].map((m) => m[0]));

  it('finds the reads in the source', () => {
    expect(reads).toContain('STYX_FIXTURE');
    expect(reads).toContain('STYX_SESSION_ID');
  });

  it('documents every STYX_* variable the app, the CLI and the broker read', () => {
    expect(reads.filter((v) => !documented.includes(v))).toEqual([]);
  });

  it('documents no variable that no longer exists in the source', () => {
    expect(documented.filter((v) => !new RegExp(`\\b${v}\\b`).test(sources))).toEqual([]);
  });
});

describe('reference: keyboard shortcuts', () => {
  const bindings = read('apps/desktop/src/renderer/keys/bindings.ts');
  // Chord values come from the shortcuts block of the generated tokens module: `name: 'Mod+K'` or `name: ['Mod+1', …]`.
  const tokens = read('packages/tokens/src/generated.ts');
  const block = /export const shortcuts = \{([\s\S]*?)\} as const;/.exec(tokens)?.[1] ?? '';
  const chordsOf = new Map<string, string[]>();
  // Either quote style: prettier writes `palette: 'Mod+K'`, `pnpm tokens:build` writes `"palette": "Mod+K"` (CI).
  for (const m of block.matchAll(/^\s*["']?(\w+)["']?:\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/gm)) {
    chordsOf.set(
      m[1] ?? '',
      [...(m[2] ?? '').matchAll(/['"]([^'"]*)['"]/g)].map((c) => c[1] ?? ''),
    );
  }

  // Every chord a binding uses: `shortcuts.name` (and `shortcuts.name.map(…)` for arrays) or a literal `chord: '…'`.
  const used = uniq([
    ...[...bindings.matchAll(/shortcuts\.(\w+)/g)].flatMap((m) => {
      const chords = chordsOf.get(m[1] ?? '');
      if (chords === undefined)
        throw new Error(`shortcuts.${m[1]} is not in packages/tokens/src/generated.ts`);
      return chords;
    }),
    ...[...bindings.matchAll(/chord:\s*'([^']+)'/g)].map((m) => m[1] ?? ''),
  ]);

  /** The docs write `<Keys k="Esc" />`; the code says `Escape`. Compare case-insensitively with that one alias. */
  const norm = (chord: string): string =>
    chord
      .split('+')
      .map((k) => (k.toLowerCase() === 'escape' ? 'esc' : k.toLowerCase()))
      .join('+');
  const documented = new Set(
    [...page('keyboard-shortcuts').matchAll(/<Keys k="([^"]+)"/g)].map((m) => norm(m[1] ?? '')),
  );

  it('finds the bindings in the source', () => {
    expect(used.length).toBeGreaterThanOrEqual(10);
    expect(used).toContain('Mod+K');
  });

  it('documents every chord bound in bindings.ts', () => {
    expect(used.filter((c) => !documented.has(norm(c)))).toEqual([]);
  });
});

describe('reference: project.json', () => {
  const source = read('packages/core/src/project-file.ts');
  // The top-level object of `projectFileV1Schema`: its keys sit at exactly four spaces of indentation.
  const schema =
    /export const projectFileV1Schema = z\s*\.object\(\{([\s\S]*?)\n {2}\}\)/.exec(source)?.[1] ?? '';
  const keys = uniq([...schema.matchAll(/^ {4}(\$?\w+):/gm)].map((m) => m[1] ?? ''));
  const doc = page('project-json');

  it('finds the schema keys in the source', () => {
    expect(keys).toContain('version');
    expect(keys).toContain('targets');
    expect(keys.length).toBeGreaterThanOrEqual(8);
  });

  it('documents every top-level key, each under its own heading', () => {
    const headings = new Set([...doc.matchAll(/^###\s+`([$\w]+)`\s*$/gm)].map((m) => m[1] ?? ''));
    expect(keys.filter((k) => !headings.has(k))).toEqual([]);
  });
});
