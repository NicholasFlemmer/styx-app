import type { ReactNode } from 'react';
import { DocsHeader } from '@/components/docs/DocsHeader';
import { Sidebar } from '@/components/docs/Sidebar';
import { source } from '@/lib/docs';
import { navSections } from '@/lib/docs-nav';
import styles from './docs.module.css';

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#content" className={styles.skip}>
        Skip to content
      </a>
      <DocsHeader />
      <div className={styles.wrap}>
        <Sidebar sections={navSections(source.getPageTree())} />
        {children}
      </div>
    </>
  );
}
