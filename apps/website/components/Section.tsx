import type { ReactNode } from 'react';
import type { SectionId } from '@/lib/site';

type Props = { id: SectionId; title: string; lede?: string; children: ReactNode; className?: string; tone?: 'panel' };

/** A ruled row of the page: full-bleed top rule, a heading row, then the section's own body. */
export const Section = ({ id, title, lede, children, className, tone }: Props) => (
  <section id={id} className={['section', className ?? ''].join(' ').trim()} data-tone={tone} aria-labelledby={`${id}-title`}>
    <div className="wrap">
      <header className="sectionHead">
        <h2 id={`${id}-title`}>{title}</h2>
        {lede && <p>{lede}</p>}
      </header>
      {children}
    </div>
  </section>
);
