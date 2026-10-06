import type { MDXComponents } from 'mdx/types';
import type { ReactNode } from 'react';
import { CodeBlock } from './CodeBlock';
import styles from './mdx.module.css';

/** A boxed aside. `tip` is the one in lime (it's for you); `note` and `warn` are plain. */
export const Callout = ({
  type = 'note',
  title,
  children,
}: {
  type?: 'note' | 'tip' | 'warn';
  title?: string;
  children: ReactNode;
}) => (
  <aside className={styles.callout} data-type={type}>
    <span className={styles.tag}>
      {title ?? (type === 'tip' ? 'Tip' : type === 'warn' ? 'Careful' : 'Note')}
    </span>
    <div>{children}</div>
  </aside>
);

/** Numbered steps: wrap an ordered list (`1. **Do this.** Then this.`). */
export const Steps = ({ children }: { children: ReactNode }) => (
  <div className={styles.steps}>{children}</div>
);

const MAC: Record<string, string> = {
  Mod: '⌘',
  Shift: '⇧',
  Alt: '⌥',
  Ctrl: '⌃',
  Enter: '⏎',
  Esc: 'Esc',
  Tab: '⇥',
  Backspace: '⌫',
};
const PC: Record<string, string> = {
  Mod: 'Ctrl',
  Shift: 'Shift',
  Alt: 'Alt',
  Ctrl: 'Ctrl',
  Enter: 'Enter',
  Esc: 'Esc',
  Tab: 'Tab',
};

/**
 * A shortcut, written once as `Mod+Shift+N`: shown as ⌘ ⇧ N, then "Ctrl Shift N on Windows and Linux". `Mod` is ⌘ on a
 * Mac and Ctrl elsewhere, as in the app.
 */
export const Keys = ({ k }: { k: string }) => {
  const keys = k.split('+');
  const mac = keys.map((x) => MAC[x] ?? x);
  const pc = keys.map((x) => PC[x] ?? x);
  const same = mac.join() === pc.join();
  return (
    <span className={styles.keys}>
      {mac.map((x, i) => (
        <kbd key={i}>{x}</kbd>
      ))}
      {same ? null : (
        <>
          {' '}
          <span className={styles.pc}>
            (
            {pc.map((x, i) => (
              <kbd key={i}>{x}</kbd>
            ))}{' '}
            on Windows and Linux)
          </span>
        </>
      )}
    </span>
  );
};

/** A screenshot of the app (recorded from the demo data), with a caption. */
export const Shot = ({ src, alt, caption }: { src: string; alt: string; caption?: string }) => (
  <figure className={styles.shot}>
    <img src={src} alt={alt} loading="lazy" />
    {caption ? <figcaption>{caption}</figcaption> : null}
  </figure>
);

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    pre: CodeBlock,
    Callout,
    Steps,
    Keys,
    Shot,
    ...components,
  };
}

export const useMDXComponents = getMDXComponents;
