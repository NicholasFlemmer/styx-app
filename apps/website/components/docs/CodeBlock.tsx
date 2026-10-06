'use client';

import { useRef, useState, type HTMLAttributes } from 'react';
import styles from './mdx.module.css';

/** Every code block gets a Copy button (the code's text, without the button's own label). */
export function CodeBlock({ children, className, ...rest }: HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.code}>
      <pre ref={ref} className={className} {...rest}>
        {children}
      </pre>
      <button
        type="button"
        className={styles.copy}
        onClick={async () => {
          await navigator.clipboard.writeText(ref.current?.innerText ?? '');
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
