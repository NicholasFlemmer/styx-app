import { describe, expect, it } from 'vitest';
import { inlineText, parseInline, parseMarkdown, type Block, type Inline } from './parse-markdown';

const t = (text: string): Inline => ({ kind: 'text', text });
const p = (...children: Inline[]): Block => ({ kind: 'paragraph', children });

/** The reply from the owner's screenshot: numbered items with `**Title.**` inline, `- ` bullets, a bold lead. */
const SCREENSHOT = `Here's what I found:

1. **Broken images.** The hero and three product cards point at \`/img/…\` paths that were moved to \`/static/img/\`.
2. **Missing meta.** \`about.html\` and \`contact.html\` have no description tag.
3. **Layout.** The footer overflows on narrow widths.

- Fix the image paths
- Add the meta tags
- Constrain the footer

**Site-wide**, the CSS is loaded twice. Want me to fix all three?`;

describe('parseMarkdown', () => {
  const cases: { name: string; src: string; blocks: Block[] }[] = [
    { name: 'empty text', src: '', blocks: [] },
    { name: 'blank lines only', src: '\n\n  \n', blocks: [] },
    {
      name: 'plain paragraph',
      src: 'Read checkout.ts and pay.ts.',
      blocks: [p(t('Read checkout.ts and pay.ts.'))],
    },
    {
      name: 'two paragraphs',
      src: 'One.\n\nTwo.',
      blocks: [p(t('One.')), p(t('Two.'))],
    },
    {
      name: 'single newline is a hard break inside a paragraph',
      src: 'line one\nline two',
      blocks: [p(t('line one'), { kind: 'break' }, t('line two'))],
    },
    {
      name: 'two-space and backslash hard breaks',
      src: 'a  \nb\\\nc',
      blocks: [p(t('a  '), { kind: 'break' }, t('b'), { kind: 'break' }, t('c'))],
    },
    {
      name: 'headings 1–3 (4+ clamp to 3, closing hashes stripped)',
      src: '# One\n## Two\n### Three\n#### Four ##',
      blocks: [
        { kind: 'heading', level: 1, children: [t('One')] },
        { kind: 'heading', level: 2, children: [t('Two')] },
        { kind: 'heading', level: 3, children: [t('Three')] },
        { kind: 'heading', level: 3, children: [t('Four')] },
      ],
    },
    { name: 'a hash without a space is text', src: '#hashtag', blocks: [p(t('#hashtag'))] },
    {
      name: 'bold and italic (both syntaxes)',
      src: '**bold** and __bold__ and *it* and _it_',
      blocks: [
        p(
          { kind: 'strong', children: [t('bold')] },
          t(' and '),
          { kind: 'strong', children: [t('bold')] },
          t(' and '),
          { kind: 'em', children: [t('it')] },
          t(' and '),
          { kind: 'em', children: [t('it')] },
        ),
      ],
    },
    {
      name: 'nested emphasis inside strong',
      src: '**bold *and italic***',
      blocks: [p({ kind: 'strong', children: [t('bold '), { kind: 'em', children: [t('and italic')] }] })],
    },
    {
      name: 'snake_case and lone asterisks stay literal',
      src: 'use snake_case_names and 2 * 3 * 4',
      blocks: [p(t('use snake_case_names and 2 * 3 * 4'))],
    },
    {
      name: 'unterminated bold stays literal (streaming)',
      src: 'Now **bold',
      blocks: [p(t('Now **bold'))],
    },
    {
      name: 'inline code keeps its content verbatim, double backticks nest a backtick',
      src: 'run `pnpm test` or `` a`b ``',
      blocks: [p(t('run '), { kind: 'code', text: 'pnpm test' }, t(' or '), { kind: 'code', text: 'a`b' })],
    },
    {
      name: 'markdown inside inline code is not parsed',
      src: '`**not bold**`',
      blocks: [p({ kind: 'code', text: '**not bold**' })],
    },
    {
      name: 'fenced code with a language label',
      src: '```ts\nconst a = 1;\n**x**\n```\nafter',
      blocks: [{ kind: 'code', lang: 'ts', text: 'const a = 1;\n**x**', open: false }, p(t('after'))],
    },
    {
      name: 'fenced code without a language, tilde fences, longer closing fence',
      src: '~~~\nplain\n~~~~\n\n````\n```\ninner\n```\n````',
      blocks: [
        { kind: 'code', lang: null, text: 'plain', open: false },
        { kind: 'code', lang: null, text: '```\ninner\n```', open: false },
      ],
    },
    {
      name: 'unterminated fence renders as an open code block (streaming)',
      src: 'Here:\n```sh\npnpm test\n',
      blocks: [p(t('Here:')), { kind: 'code', lang: 'sh', text: 'pnpm test\n', open: true }],
    },
    {
      name: 'unordered list with -, * and + markers',
      src: '- a\n* b\n+ c',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          start: 1,
          items: [{ children: [p(t('a'))] }, { children: [p(t('b'))] }, { children: [p(t('c'))] }],
        },
      ],
    },
    {
      name: 'ordered list keeps its start number',
      src: '3. c\n4. d',
      blocks: [
        {
          kind: 'list',
          ordered: true,
          start: 3,
          items: [{ children: [p(t('c'))] }, { children: [p(t('d'))] }],
        },
      ],
    },
    {
      name: 'nested lists by indentation',
      src: '1. one\n   - inner a\n   - inner b\n2. two',
      blocks: [
        {
          kind: 'list',
          ordered: true,
          start: 1,
          items: [
            {
              children: [
                p(t('one')),
                {
                  kind: 'list',
                  ordered: false,
                  start: 1,
                  items: [{ children: [p(t('inner a'))] }, { children: [p(t('inner b'))] }],
                },
              ],
            },
            { children: [p(t('two'))] },
          ],
        },
      ],
    },
    {
      name: 'nested list with two-space indent under a dash',
      src: '- a\n  - b\n- c',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          start: 1,
          items: [
            {
              children: [
                p(t('a')),
                { kind: 'list', ordered: false, start: 1, items: [{ children: [p(t('b'))] }] },
              ],
            },
            { children: [p(t('c'))] },
          ],
        },
      ],
    },
    {
      name: 'switching marker type at the same level starts a new list',
      src: '- a\n1. b',
      blocks: [
        { kind: 'list', ordered: false, start: 1, items: [{ children: [p(t('a'))] }] },
        { kind: 'list', ordered: true, start: 1, items: [{ children: [p(t('b'))] }] },
      ],
    },
    {
      name: 'lazy continuation stays in the item; a blank line then unindented text ends the list',
      src: '- a\ncontinued\n\nAfter.',
      blocks: [
        {
          kind: 'list',
          ordered: false,
          start: 1,
          items: [{ children: [p(t('a'), { kind: 'break' }, t('continued'))] }],
        },
        p(t('After.')),
      ],
    },
    {
      name: 'loose list: blank lines between items keep one list',
      src: '1. a\n\n2. b',
      blocks: [
        {
          kind: 'list',
          ordered: true,
          start: 1,
          items: [{ children: [p(t('a'))] }, { children: [p(t('b'))] }],
        },
      ],
    },
    {
      name: 'a number followed by text without a space is a paragraph',
      src: '2024.Something',
      blocks: [p(t('2024.Something'))],
    },
    {
      name: 'blockquote with inline markup',
      src: '> quoted **bold**\n> more',
      blocks: [
        {
          kind: 'quote',
          children: [
            p(t('quoted '), { kind: 'strong', children: [t('bold')] }, { kind: 'break' }, t('more')),
          ],
        },
      ],
    },
    {
      name: 'horizontal rules (---, ***, _ _ _) and a paragraph around them',
      src: 'a\n\n---\n***\n_ _ _\n\nb',
      blocks: [p(t('a')), { kind: 'rule' }, { kind: 'rule' }, { kind: 'rule' }, p(t('b'))],
    },
    {
      name: 'links: inline, angle autolink, bare https; non-http schemes become text',
      src: 'See [docs](https://x.dev/a) or <https://y.dev> or https://z.dev/p. Not [js](javascript:alert(1)).',
      blocks: [
        p(
          t('See '),
          { kind: 'link', href: 'https://x.dev/a', children: [t('docs')] },
          t(' or '),
          { kind: 'link', href: 'https://y.dev', children: [t('https://y.dev')] },
          t(' or '),
          { kind: 'link', href: 'https://z.dev/p', children: [t('https://z.dev/p')] },
          t('. Not js.'),
        ),
      ],
    },
    {
      name: 'link with a title and nested emphasis',
      src: '[**bold** link](https://a.b "title")',
      blocks: [
        p({
          kind: 'link',
          href: 'https://a.b',
          children: [{ kind: 'strong', children: [t('bold')] }, t(' link')],
        }),
      ],
    },
    {
      name: 'table with alignment row, escaped pipe and a short row',
      src: '| a | b |\n|:--|--:|\n| 1 | x\\|y |\n| 2 |',
      blocks: [
        {
          kind: 'table',
          align: ['left', 'right'],
          header: [[t('a')], [t('b')]],
          rows: [
            [[t('1')], [t('x|y')]],
            [[t('2')], []],
          ],
        },
      ],
    },
    {
      name: 'a pipe line without a delimiter row is a paragraph',
      src: 'a | b\nc | d',
      blocks: [p(t('a | b'), { kind: 'break' }, t('c | d'))],
    },
    {
      name: 'html is literal text, backslash escapes drop the backslash',
      src: '<b>x</b> \\*not em\\* \\# not heading',
      blocks: [p(t('<b>x</b> *not em* # not heading'))],
    },
    {
      name: 'headings and fences end a paragraph without a blank line',
      src: 'text\n# Head\nmore\n```\ncode\n```',
      blocks: [
        p(t('text')),
        { kind: 'heading', level: 1, children: [t('Head')] },
        p(t('more')),
        { kind: 'code', lang: null, text: 'code', open: false },
      ],
    },
    {
      name: 'CRLF input',
      src: 'a\r\n\r\nb',
      blocks: [p(t('a')), p(t('b'))],
    },
    {
      name: "the owner's screenshot reply: numbered **Title.** items, dash bullets, **Site-wide** lead",
      src: SCREENSHOT,
      blocks: [
        p(t("Here's what I found:")),
        {
          kind: 'list',
          ordered: true,
          start: 1,
          items: [
            {
              children: [
                p(
                  { kind: 'strong', children: [t('Broken images.')] },
                  t(' The hero and three product cards point at '),
                  { kind: 'code', text: '/img/…' },
                  t(' paths that were moved to '),
                  { kind: 'code', text: '/static/img/' },
                  t('.'),
                ),
              ],
            },
            {
              children: [
                p(
                  { kind: 'strong', children: [t('Missing meta.')] },
                  t(' '),
                  { kind: 'code', text: 'about.html' },
                  t(' and '),
                  { kind: 'code', text: 'contact.html' },
                  t(' have no description tag.'),
                ),
              ],
            },
            {
              children: [
                p({ kind: 'strong', children: [t('Layout.')] }, t(' The footer overflows on narrow widths.')),
              ],
            },
          ],
        },
        {
          kind: 'list',
          ordered: false,
          start: 1,
          items: [
            { children: [p(t('Fix the image paths'))] },
            { children: [p(t('Add the meta tags'))] },
            { children: [p(t('Constrain the footer'))] },
          ],
        },
        p(
          { kind: 'strong', children: [t('Site-wide')] },
          t(', the CSS is loaded twice. Want me to fix all three?'),
        ),
      ],
    },
  ];

  it.each(cases)('$name', ({ src, blocks }) => {
    expect(parseMarkdown(src)).toEqual(blocks);
  });

  it('never throws on odd input', () => {
    for (const src of ['`', '**', '[', '[a](', '|', '| a |\n|-|', '```', '- ', '1.', '>', '\\']) {
      expect(() => parseMarkdown(src)).not.toThrow();
    }
  });
});

describe('parseInline / inlineText', () => {
  it('merges adjacent text runs and round-trips plain text', () => {
    const nodes = parseInline('a \\* b');
    expect(nodes).toEqual([t('a * b')]);
    expect(inlineText(parseInline('**x** `y`\nz'))).toBe('x y\nz');
  });
});
