import { describe, expect, it } from 'vitest';
import { splitFrontmatter } from './frontmatter';

describe('splitFrontmatter', () => {
  it('reads plain scalars and returns the body after the closing rule', () => {
    expect(splitFrontmatter('---\nname: pdf\ndescription: fills forms\n---\n# PDF\n\nbody')).toEqual({
      name: 'pdf',
      description: 'fills forms',
      body: '# PDF\n\nbody',
    });
  });

  it('strips quotes from quoted scalars, keeping punctuation inside them', () => {
    const md = '---\nname: "ui-ux"\ndescription: \'Design: 67 styles. Use when asked.\'\n---\ntext';
    expect(splitFrontmatter(md)).toEqual({
      name: 'ui-ux',
      description: 'Design: 67 styles. Use when asked.',
      body: 'text',
    });
  });

  it('joins folded and literal blocks into one line', () => {
    const md = [
      '---',
      'name: seo',
      'description: >',
      '  Strategic planning',
      '  for sites.',
      'tags: |-',
      '  a',
      '---',
      'b',
    ].join('\n');
    expect(splitFrontmatter(md)).toEqual({
      name: 'seo',
      description: 'Strategic planning for sites.',
      body: 'b',
    });
  });

  it('handles CRLF and a file that ends at the closing rule', () => {
    expect(splitFrontmatter('---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\n')).toEqual({
      name: 'x',
      description: 'y',
      body: 'body\r\n',
    });
    expect(splitFrontmatter('---\nname: x\n---')).toEqual({ name: 'x', description: null, body: '' });
  });

  it('returns the whole text as body when there is no frontmatter, and nulls for missing keys', () => {
    expect(splitFrontmatter('# just a heading')).toEqual({
      name: null,
      description: null,
      body: '# just a heading',
    });
    expect(splitFrontmatter('---\nother: 1\n---\nbody')).toEqual({
      name: null,
      description: null,
      body: 'body',
    });
  });
});
