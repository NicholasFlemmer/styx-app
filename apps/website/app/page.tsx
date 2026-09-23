import { Compat } from '@/components/Compat';
import { Counters } from '@/components/Counters';
import { DemoProvider } from '@/components/demo/DemoContext';
import { ScreensStrip } from '@/components/ScreensStrip';
import { Download } from '@/components/Download';
import { Footer } from '@/components/Footer';
import { GrantFlow } from '@/components/GrantFlow';
import { Hero } from '@/components/Hero';
import { Invariants } from '@/components/Invariants';
import { Keyboard } from '@/components/Keyboard';
import { Nav } from '@/components/Nav';
import { Pillars } from '@/components/Pillars';
import { Ship } from '@/components/Ship';
import { Worktrees } from '@/components/Worktrees';

export default function Page() {
  return (
    <>
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
        <Ship />
        <ScreensStrip />
        <Invariants />
        <Keyboard />
        <Download />
      </main>
      <Footer />
    </>
  );
}
