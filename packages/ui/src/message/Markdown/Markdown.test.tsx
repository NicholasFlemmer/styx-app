import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';

afterEach(cleanup);

describe('Markdown', () => {
  it('renders a plain reply as one paragraph with no extra markup', () => {
    const { container } = render(<Markdown text="Read checkout.ts and pay.ts." />);
    const root = container.querySelector('[data-markdown="true"]');
    expect(root?.children).toHaveLength(1);
    expect(root?.firstElementChild?.tagName).toBe('P');
    expect(root?.textContent).toBe('Read checkout.ts and pay.ts.');
  });

  it('renders headings, emphasis, inline code and hard breaks as elements, never HTML', () => {
    const { container } = render(<Markdown text={'# Title\n**bold** *it* `code` <b>x</b>\nnext'} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('it');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>x</b>');
    expect(container.querySelector('br')).not.toBeNull();
  });

  it('renders fenced code with a language tag and marks an open fence', () => {
    const { container } = render(<Markdown text={'```ts\nconst a = 1;\n```\n\n```\nopen'} />);
    const pres = container.querySelectorAll('pre');
    expect(pres).toHaveLength(2);
    expect(pres[0]?.getAttribute('data-lang')).toBe('ts');
    expect(pres[0]?.querySelector('code')?.textContent).toBe('const a = 1;');
    expect(pres[1]?.getAttribute('data-open')).toBe('true');
  });

  it('renders ordered / unordered lists with nesting and a start number', () => {
    const { container } = render(<Markdown text={'3. a\n   - inner\n4. b'} />);
    const ol = container.querySelector('ol');
    expect(ol?.getAttribute('start')).toBe('3');
    expect(ol?.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(ol?.querySelector('li ul li')?.textContent).toBe('inner');
  });

  it('links call onLink instead of navigating; without onLink they are plain text', async () => {
    const user = userEvent.setup();
    const onLink = vi.fn();
    render(<Markdown text="See [docs](https://x.dev/a)" onLink={onLink} />);
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link.getAttribute('href')).toBe('https://x.dev/a');
    await user.click(link);
    expect(onLink).toHaveBeenCalledWith('https://x.dev/a');
    cleanup();
    render(<Markdown text="See [docs](https://x.dev/a)" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('docs')).toBeInTheDocument();
  });

  it('renders blockquotes, rules and tables', () => {
    const { container } = render(<Markdown text={'> q\n\n---\n\n| a | b |\n|---|--:|\n| 1 | 2 |'} />);
    expect(container.querySelector('blockquote')?.textContent).toBe('q');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(screen.getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['a', 'b']);
    const cells = screen.getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual(['1', '2']);
    expect(cells[1]?.style.textAlign).toBe('right');
  });

  it('decorates plain text runs through renderText but not code', () => {
    const { container } = render(
      <Markdown
        text={'see checkout.ts and `pay.ts`'}
        renderText={(t) =>
          t.split('checkout.ts').flatMap((s, i) => (i === 0 ? [s] : [<i key={i}>checkout.ts</i>, s]))
        }
      />,
    );
    expect(container.querySelector('i')?.textContent).toBe('checkout.ts');
    expect(container.querySelector('code')?.textContent).toBe('pay.ts');
  });
});
