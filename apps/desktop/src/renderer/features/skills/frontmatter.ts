/**
 * Splits a SKILL.md into its `name` / `description` frontmatter and the markdown body the reader renders.
 *
 * The same subset the main-process `parseFrontmatter` reads (plain scalars, quoted scalars, folded / literal
 * blocks) — kept here because the renderer cannot import main, and the text arrives raw from `skills.preview`.
 */
export interface SkillText {
  name: string | null;
  description: string | null;
  /** Everything after the closing `---`, or the whole text when there is no frontmatter. */
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const unquote = (value: string): string =>
  (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
  (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ? value.slice(1, -1)
    : value;

export const splitFrontmatter = (text: string): SkillText => {
  const m = FRONTMATTER.exec(text);
  if (m === null) return { name: null, description: null, body: text };
  const lines = (m[1] ?? '').split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? '');
    if (kv === null) continue;
    const key = (kv[1] ?? '').toLowerCase();
    let value = (kv[2] ?? '').trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? '';
        if (next.trim() !== '' && !/^\s/.test(next)) break;
        block.push(next.trim());
        i = j;
      }
      value = block.join(' ').trim();
    } else value = unquote(value);
    out[key] = value;
  }
  return {
    name: out['name'] ?? null,
    description: out['description'] ?? null,
    body: text.slice(m[0].length),
  };
};
