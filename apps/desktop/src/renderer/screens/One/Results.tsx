import {
  copy,
  fill,
  type ProjectId,
  type ReportResult,
  type SessionId,
  type TaskResult,
} from '@styx/core';
import { Button } from '@styx/ui';
import { ShareConversation } from '../../features/hub/ShareConversation';
import { useSpawnForm } from '../../features/modals/use-spawn-form';
import { useUi } from '../../state/hooks';
import { CampaignView } from './Campaign';
import s from './Results.module.css';

/** A task's result drawn as Styx draws it (ADR-0033): a campaign or a report, on paper. */
export function ResultView({ result }: { result: TaskResult }) {
  return result.body.kind === 'campaign' ? (
    // Keyed by the result: a replaced plan starts with its own picks, never the old ones.
    <CampaignView key={result.updatedAt} result={result} body={result.body} />
  ) : (
    <ReportView result={result} body={result.body} />
  );
}

function ReportView({ result, body }: { result: TaskResult; body: ReportResult }) {
  const r = copy.one.results;
  const max = Math.max(1, ...(body.bars?.items.map((b) => b.value) ?? [1]));
  return (
    <article className={s['paper']} data-one-result="report" aria-label={body.title}>
      <span className={s['mu']}>
        {[
          body.period,
          body.sources.length > 0 ? fill(r.sources, { sources: body.sources.join(' and ') }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <h2 className={s['headline']}>{body.headline}</h2>
      {body.summary === undefined ? null : <p className={s['lede']}>{body.summary}</p>}
      {body.metrics.length > 0 ? (
        <dl className={s['metrics']}>
          {body.metrics.map((m) => (
            <div key={m.label} className={s['metric']}>
              <dt>{m.label}</dt>
              <dd>
                <b>{m.value}</b>
                {m.change === undefined ? null : (
                  <span data-good={m.good === undefined ? undefined : String(m.good)}>{m.change}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {body.bars === undefined ? null : (
        <section aria-label={body.bars.title}>
          <h3 className={s['h']}>{body.bars.title}</h3>
          <ul className={s['bars']}>
            {body.bars.items.map((b) => (
              <li key={b.label} className={s['bar']}>
                <span>{b.label}</span>
                <span className={s['track']} aria-hidden="true">
                  <span className={s['fill']} style={{ width: `${(b.value / max) * 100}%` }} />
                </span>
                <span className={s['num']}>{b.value.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {body.table === undefined ? null : (
        <div className={s['tableWrap']}>
          <table className={s['table']}>
            <thead>
              <tr>
                {body.table.columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) =>
                    j === 0 ? (
                      <th key={j} scope="row">
                        {cell}
                      </th>
                    ) : (
                      <td key={j}>{cell}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className={s['shareRow']} aria-label={r.share}>
        <h3 className={s['h']}>{r.share}</h3>
        <ShareConversation sessionId={result.id as SessionId} messageId={null} />
      </section>
      {body.recommendations.length > 0 ? (
        <Recommendations
          projectId={result.projectId as ProjectId}
          title={body.title}
          items={body.recommendations}
        />
      ) : null}
    </article>
  );
}

/** "Do this" starts a task in the same project with the recommendation as its first message. */
function Recommendations({
  projectId,
  title,
  items,
}: {
  projectId: ProjectId;
  title: string;
  items: ReportResult['recommendations'];
}) {
  const r = copy.one.results;
  const { spawn, busy } = useSpawnForm(projectId);
  const openSession = useUi((u) => u.openSession);
  const setScreen = useUi((u) => u.setScreen);
  const start = async (rec: ReportResult['recommendations'][number]) => {
    const id = await spawn(
      fill(r.doThisMessage, { report: title, title: rec.title, why: rec.why ?? '' }).trim(),
    );
    if (id === null) return;
    openSession(projectId, id);
    setScreen('one-task');
  };
  return (
    <section aria-label={r.recommendations}>
      <h3 className={s['h']}>{r.recommendations}</h3>
      <ul className={s['recs']}>
        {items.map((rec) => (
          <li key={rec.title} className={s['rec']}>
            <span>
              <b>{rec.title}</b>
              {rec.why === undefined ? null : <span className={s['mu']}> {rec.why}</span>}
            </span>
            <Button size="regular" disabled={busy} onClick={() => void start(rec)}>
              {r.doThis}
            </Button>
          </li>
        ))}
      </ul>
      <p className={s['mu']}>{r.doThisNote}</p>
    </section>
  );
}
