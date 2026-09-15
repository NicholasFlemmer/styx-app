/**
 * The skill catalogue, answered offline for fixture and e2e runs.
 *
 * Mirrors the two URL shapes `SkillsService` fetches from the pinned `anthropics/skills` repo: the GitHub contents
 * listing of `skills/` and one raw `SKILL.md` per directory. Three canned skills (`pdf` is the one the demo fixture
 * already has installed for Claude Code); any other URL answers 404, so a fixture never reaches the network.
 */

const CATALOGUE_REPO = 'anthropics/skills';
const CATALOGUE_PATH = 'skills';
const CONTENTS_URL = `https://api.github.com/repos/${CATALOGUE_REPO}/contents/${CATALOGUE_PATH}`;
const RAW_PREFIX = `https://raw.githubusercontent.com/${CATALOGUE_REPO}/main/${CATALOGUE_PATH}/`;

export interface FixtureSkill {
  directory: string;
  name: string;
  description: string;
  /** Markdown after the frontmatter. */
  body: string;
}

/** A SKILL.md in the layout every agent CLI reads: `name` / `description` frontmatter, then the instructions. */
export const fixtureSkillMarkdown = (skill: { name: string; description: string; body?: string }): string =>
  [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    '---',
    '',
    skill.body ?? `# ${skill.name}\n\n${skill.description}\n`,
  ].join('\n');

export const FIXTURE_CATALOGUE: readonly FixtureSkill[] = [
  {
    directory: 'pdf',
    name: 'pdf',
    description: 'Read, fill and merge PDF files with the pdf toolkit.',
    body: [
      '# pdf',
      '',
      'Use this skill when asked to read, fill or merge PDF files.',
      '',
      '## Workflow',
      '',
      '1. Inspect the file with `pdfinfo` before changing it.',
      '2. Fill forms field by field; never flatten until asked.',
      '3. Merge with page ranges, not whole files.',
      '',
      '```bash',
      'pdftk in.pdf dump_data_fields',
      '```',
      '',
    ].join('\n'),
  },
  {
    directory: 'xlsx',
    name: 'xlsx',
    description: 'Create, read and edit spreadsheets: formulas, formatting and charts.',
    body: [
      '# xlsx',
      '',
      'Use this skill for `.xlsx` workbooks: reading cells, writing formulas and keeping formatting intact.',
      '',
      '## Rules',
      '',
      '- Recalculate after every formula change and check for `#REF!` before handing the file back.',
      '- Keep the original sheet order; add new sheets at the end.',
      '- Never overwrite a workbook in place; write a copy next to it.',
      '',
    ].join('\n'),
  },
  {
    directory: 'frontend-design',
    name: 'frontend-design',
    description: 'Build distinctive, production-grade interfaces rather than templated defaults.',
    body: [
      '# frontend-design',
      '',
      'Use this skill when building or reshaping UI. Pick one aesthetic direction and commit to it.',
      '',
      '## Checklist',
      '',
      '- Typography first: one display face, one text face, a real scale.',
      '- Spacing on a grid; no arbitrary pixel values.',
      '- Motion only where it explains a state change.',
      '',
    ].join('\n'),
  },
];

/** The canned SKILL.md for a catalogue directory, or null when it is not in the fixture. */
export const fixtureCatalogueText = (directory: string): string | null => {
  const skill = FIXTURE_CATALOGUE.find((s) => s.directory === directory);
  return skill === undefined ? null : fixtureSkillMarkdown(skill);
};

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

const notFound = (): Response => new Response('not found', { status: 404 });

/** True for the two catalogue hosts, whatever the path: those are the requests a fixture must never let out. */
export const isCatalogueUrl = (url: string): boolean => url === CONTENTS_URL || url.startsWith(RAW_PREFIX);

/**
 * `fetch` for the catalogue only: the contents listing, one SKILL.md per canned skill, 404 for everything else.
 * e2e runs give the whole container this so nothing reaches the network.
 */
export const fixtureSkillsFetch: typeof fetch = async (input) => {
  const url = urlOf(input);
  if (url === CONTENTS_URL) {
    return json([
      ...FIXTURE_CATALOGUE.map((s) => ({ name: s.directory, type: 'dir' })),
      // The real listing carries non-skill entries too; the service must skip them.
      { name: 'README.md', type: 'file' },
      { name: 'template', type: 'dir' },
    ]);
  }
  if (url.startsWith(RAW_PREFIX)) {
    const m = /^([^/]+)\/SKILL\.md$/.exec(url.slice(RAW_PREFIX.length));
    const text = m?.[1] === undefined ? null : fixtureCatalogueText(m[1]);
    return text === null ? notFound() : new Response(text, { status: 200 });
  }
  return notFound();
};

/**
 * `fetch` for a fixture-seeded dev run: the catalogue is answered from the fixture, every other request (provider
 * connect / test flows the developer may still exercise) goes to the real network.
 */
export const fixtureCatalogueFetch =
  (real: typeof fetch): typeof fetch =>
  (input, init) =>
    isCatalogueUrl(urlOf(input)) ? fixtureSkillsFetch(input, init) : real(input, init);
