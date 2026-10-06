import type { Metadata } from 'next';
import { Compat } from '@/components/Compat';
import { StructuredData } from '@/components/StructuredData';
import { Counters } from '@/components/Counters';
import { DesignBuild } from '@/components/DesignBuild';
import { DemoProvider } from '@/components/demo/DemoContext';
import { Download } from '@/components/Download';
import { Footer } from '@/components/Footer';
import { GrantFlow } from '@/components/GrantFlow';
import { Hero } from '@/components/Hero';
import { Invariants } from '@/components/Invariants';
import { Keyboard } from '@/components/Keyboard';
import { Nav } from '@/components/Nav';
import { OpenSource } from '@/components/OpenSource';
import { Pillars } from '@/components/Pillars';
import { Ship } from '@/components/Ship';
import { Worktrees } from '@/components/Worktrees';

/** The home page's own canonical; the legal pages set theirs, and the 404 is noindex. */
export const metadata: Metadata = { alternates: { canonical: '/' } };

export default function Page() {
  return (
    <>
      <StructuredData />
      <a href="#main" className="srOnly">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <DemoProvider>
          <Hero />
          <Counters />
        </DemoProvider>
        <Pillars />
        <GrantFlow />
        <Compat />
        <Worktrees />
        <DesignBuild />
        <Ship />
        <Invariants />
        <Keyboard />
        <Download />
        <OpenSource />
      </main>
      <Footer />
    </>
  );
}
