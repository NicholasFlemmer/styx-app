import type { Meta, StoryObj } from '@storybook/react-vite';
import { Message } from '../Message';
import { Markdown } from './Markdown';

const meta = {
  title: 'Message/Markdown',
  component: Markdown,
  args: { onLink: () => {} },
  decorators: [
    (Story) => (
      <div style={{ width: 360, padding: 14, background: 'var(--s1)' }}>
        <Message kind="agent">
          <Story />
        </Message>
      </div>
    ),
  ],
} satisfies Meta<typeof Markdown>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Prototype-style plain reply: identical to the bare bubble (no markdown syntax → one paragraph). */
export const Plain: Story = {
  args: { text: 'Read checkout.ts and pay.ts. Plan: new validate.ts, call it before summing, add 4 tests.' },
};

/** The owner's screenshot reply: numbered `**Title.**` items, dash bullets, a bold lead. */
export const Screenshot: Story = {
  args: {
    text: `Here's what I found:

1. **Broken images.** The hero and three product cards point at \`/img/…\` paths that were moved to \`/static/img/\`.
2. **Missing meta.** \`about.html\` and \`contact.html\` have no description tag.
3. **Layout.** The footer overflows on narrow widths.

- Fix the image paths
- Add the meta tags
- Constrain the footer

**Site-wide**, the CSS is loaded twice. Want me to fix all three?`,
  },
};

export const HeadingsAndEmphasis: Story = {
  args: {
    text: `# Summary
Body text right under a heading, with **bold**, *italic* and \`inline code\`.
## Details
### Notes
Never larger than body.`,
  },
};

export const CodeBlock: Story = {
  args: {
    text: `Run it with:

\`\`\`sh
pnpm test -F @styx/core --coverage --reporter=verbose --some-very-long-flag-that-scrolls
\`\`\`

And without a label:

\`\`\`
plain
\`\`\``,
  },
};

/** Streaming: the closing fence has not arrived yet, so the block still renders as code. */
export const OpenFence: Story = {
  args: { text: 'Patch:\n\n```ts\nexport const a = 1;\nexport const b =' },
};

export const NestedLists: Story = {
  args: {
    text: `1. Install
   - \`pnpm i\`
   - \`pnpm build\`
2. Verify
   1. typecheck
   2. tests
10. Ship`,
  },
};

export const QuoteRuleLinks: Story = {
  args: {
    text: `> The renderer never touches fs.

---

See [the spec](https://example.com/spec) or https://example.com/plain.`,
  },
};

export const Table: Story = {
  args: {
    text: `| File | Added | Removed |
|:-----|------:|--------:|
| validate.ts | 31 | 0 |
| checkout.ts | 2 | 0 |
| checkout.test.ts | 44 | 0 |`,
  },
};

export const Matrix: Story = {
  args: { text: '' },
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Markdown text="Plain paragraph." />
      <Markdown text={'# Heading\n- a\n- b'} />
      <Markdown text={'```ts\nconst x = 1;\n```'} />
      <Markdown text="> quoted" />
      <Markdown text={'| a | b |\n|---|---|\n| 1 | 2 |'} />
    </div>
  ),
};
