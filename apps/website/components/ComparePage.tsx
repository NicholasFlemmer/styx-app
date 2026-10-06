import { LegalPage } from './Legal';
import { ROWS, type Competitor } from '@/lib/compare/types';
import { SHARED_FAQ, STYX_CELLS, STYX_LIMIT, STYX_POINTS } from '@/lib/compare/styx';
import { site } from '@/lib/site';

const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/** One comparison: the short version, the table, where they are ahead, where Styx differs, a choice, FAQ, sources. */
export const ComparePage = ({ c }: { c: Competitor }) => {
  const faq = [...c.faq, ...SHARED_FAQ];
  const schema = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        mainEntity: faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Styx', item: `${site.url}/` },
          { '@type': 'ListItem', position: 2, name: 'Compare', item: `${site.url}/compare` },
          {
            '@type': 'ListItem',
            position: 3,
            name: `Styx vs ${c.name}`,
            item: `${site.url}/compare/${c.slug}`,
          },
        ],
      },
    ],
  };
  return (
    <LegalPage
      title={`Styx vs ${c.name}`}
      meta={`Checked ${c.checked}`}
      summaryLabel="The short version"
      navCurrent="compare"
      summary={
        <ul>
          {c.summary.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      }
    >
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json(schema) }} />
      <p>{c.intro}</p>

      <h2>Side by side</h2>
      <table>
        <caption className="srOnly">Styx and {c.name} compared, feature by feature</caption>
        <thead>
          <tr>
            <td></td>
            <th scope="col">Styx</th>
            <th scope="col">{c.name}</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([key, label]) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              <td>{STYX_CELLS[key]}</td>
              <td>{c.cells[key]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        &ldquo;Not part of its docs&rdquo; means we could not find it in {c.name}&apos;s own material on{' '}
        {c.checked}, not that it can never be done with it. Tell us at{' '}
        <a href={`mailto:${site.email}`}>{site.email}</a> if something here is wrong and we will fix it.
      </p>

      <h2>Where {c.name} is ahead</h2>
      <ul>
        {c.ahead.map((a) => (
          <li key={a.title}>
            <strong>{a.title}.</strong> {a.text}
          </li>
        ))}
      </ul>

      <h2>Where Styx is different</h2>
      {c.styxPoints.map((k) => (
        <div key={k}>
          <h3>{STYX_POINTS[k].title}</h3>
          <p>{STYX_POINTS[k].text}</p>
        </div>
      ))}
      <p>{STYX_LIMIT}</p>

      <h2>Which to choose</h2>
      <p>
        Choose <strong>{c.name}</strong> if {c.choose.them}. Choose <strong>Styx</strong> if {c.choose.styx}.
      </p>
      <p>
        <a href="/#download">Download Styx</a>. It is free and open source.{' '}
        <a href="/compare">See every comparison</a>.
      </p>

      <h2>Questions</h2>
      {faq.map((f) => (
        <div key={f.q}>
          <h3>{f.q}</h3>
          <p>{f.a}</p>
        </div>
      ))}

      <h2>Sources</h2>
      <ul>
        {c.sources.map((s) => (
          <li key={s.url}>
            <a href={s.url} rel="noopener">
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </LegalPage>
  );
};
