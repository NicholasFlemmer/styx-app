import type { Metadata } from 'next';
import { LegalPage } from '@/components/Legal';
import { COMPETITORS } from '@/lib/compare';

export const metadata: Metadata = {
  title: { absolute: 'Compare Styx with other ADEs and coding agent apps' },
  description:
    'How Styx compares with other agentic development environments and coding agent apps: what each does, where they are ahead, and when to choose which.',
  alternates: { canonical: '/compare' },
};

/** The index of comparisons, linked from the nav. */
export default function CompareIndex() {
  return (
    <LegalPage
      title="Compare"
      meta={`${COMPETITORS.length} ${COMPETITORS.length === 1 ? 'comparison' : 'comparisons'}`}
      summaryLabel="How these are written"
      navCurrent="compare"
      summary={
        <ul>
          <li>Facts about other products come from their own sites and docs, linked on each page.</li>
          <li>Each page says where the other product is ahead, not only where Styx is.</li>
          <li>Something wrong? Email hello@heystyx.com and we will fix it.</li>
        </ul>
      }
    >
      <p>
        Styx is an agentic development environment (ADE) for Mac: every project and every coding agent in one
        window, and nothing reaching production without your OK. Here is how it compares with the other tools
        people weigh it against.
      </p>
      <ul>
        {COMPETITORS.map((c) => (
          <li key={c.slug}>
            <a href={`/compare/${c.slug}`}>
              <strong>Styx vs {c.name}</strong>
            </a>
            : {c.what}
          </li>
        ))}
      </ul>
    </LegalPage>
  );
}
