import { Fragment, useMemo, type ReactNode } from 'react';
import s from './Markdown.module.css';
import { parseMarkdown, type Block, type Inline } from './parse-markdown';

export interface MarkdownProps {
  text: string;
  /** Links never navigate; the host opens `url` (app: `link.open`). Without it links render as plain text. */
  onLink?: (url: string) => void;
  /** Decorates plain text runs (app: file names in mono). Defaults to the text itself. */
  renderText?: (text: string) => ReactNode;
  className?: string;
}

/**
 * Rendered markdown for agent replies (owner addition, docs/handoff-discrepancies #57). Body-sized throughout:
 * headings are bold 13px (never larger than body), code is 12px mono on `--s2` / `--s1`, lists use square
 * `--mu` markers and tabular numerals, tables are hairline mono. No HTML injection: the tree is React nodes.
 */
export function Markdown({ text, onLink, renderText, className }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const ctx: Ctx = { onLink, renderText };
  return (
    <div className={[s['md'], className].filter(Boolean).join(' ')} data-markdown="true">
      {blocks.map((b, i) => (
        <Fragment key={i}>{renderBlock(b, ctx)}</Fragment>
      ))}
    </div>
  );
}

interface Ctx {
  onLink: ((url: string) => void) | undefined;
  renderText: ((text: string) => ReactNode) | undefined;
}

const renderInlines = (nodes: readonly Inline[], ctx: Ctx): ReactNode =>
  nodes.map((n, i) => <Fragment key={i}>{renderInline(n, ctx)}</Fragment>);

const renderInline = (n: Inline, ctx: Ctx): ReactNode => {
  switch (n.kind) {
    case 'text':
      return ctx.renderText === undefined ? n.text : ctx.renderText(n.text);
    case 'code':
      return <code className={s['code']}>{n.text}</code>;
    case 'strong':
      return <strong className={s['strong']}>{renderInlines(n.children, ctx)}</strong>;
    case 'em':
      return <em className={s['em']}>{renderInlines(n.children, ctx)}</em>;
    case 'break':
      return <br />;
    case 'link': {
      const { onLink } = ctx;
      if (onLink === undefined) return <span className={s['link']}>{renderInlines(n.children, ctx)}</span>;
      return (
        <a
          href={n.href}
          className={s['link']}
          title={n.href}
          onClick={(e) => {
            e.preventDefault();
            onLink(n.href);
          }}
        >
          {renderInlines(n.children, ctx)}
        </a>
      );
    }
  }
};

const renderBlocks = (blocks: readonly Block[], ctx: Ctx): ReactNode =>
  blocks.map((b, i) => <Fragment key={i}>{renderBlock(b, ctx)}</Fragment>);

const renderBlock = (b: Block, ctx: Ctx): ReactNode => {
  switch (b.kind) {
    case 'paragraph':
      return <p className={s['p']}>{renderInlines(b.children, ctx)}</p>;
    case 'heading': {
      const cls = [s['h'], b.level <= 2 ? s['hTop'] : undefined].filter(Boolean).join(' ');
      // Body-sized headings: semantic level kept for AT, size capped at 13px bold.
      if (b.level === 1) return <h1 className={cls}>{renderInlines(b.children, ctx)}</h1>;
      if (b.level === 2) return <h2 className={cls}>{renderInlines(b.children, ctx)}</h2>;
      return <h3 className={cls}>{renderInlines(b.children, ctx)}</h3>;
    }
    case 'code':
      return (
        <pre className={s['pre']} data-lang={b.lang ?? undefined} data-open={b.open ? 'true' : undefined}>
          {b.lang !== null && (
            <span className={s['lang']} aria-hidden="true">
              {b.lang}
            </span>
          )}
          <code className={s['preCode']}>{b.text}</code>
        </pre>
      );
    case 'list': {
      const items = b.items.map((item, i) => (
        <li key={i} className={s['li']}>
          {renderBlocks(item.children, ctx)}
        </li>
      ));
      return b.ordered ? (
        <ol className={s['ol']} start={b.start === 1 ? undefined : b.start}>
          {items}
        </ol>
      ) : (
        <ul className={s['ul']}>{items}</ul>
      );
    }
    case 'quote':
      return <blockquote className={s['quote']}>{renderBlocks(b.children, ctx)}</blockquote>;
    case 'rule':
      return <hr className={s['hr']} />;
    case 'table':
      return (
        <div className={s['tableWrap']}>
          <table className={s['table']}>
            <thead>
              <tr>
                {b.header.map((cell, i) => (
                  <th key={i} className={s['th']} style={alignStyle(b.align[i])}>
                    {renderInlines(cell, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={s['td']} style={alignStyle(b.align[c])}>
                      {renderInlines(cell, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
};

const alignStyle = (align: 'left' | 'center' | 'right' | null | undefined) =>
  align === undefined || align === null ? undefined : { textAlign: align };
