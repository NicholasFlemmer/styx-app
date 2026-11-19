import { copy, fill, type ProjectId, type ReportResult, type SessionId, type TaskResult } from '@styx/core';
import { Button } from '@styx/ui';
import { ShareConversation } from '../../features/hub/ShareConversation';
import { useSpawnForm } from '../../features/modals/use-spawn-form';
import { useUi } from '../../state/hooks';
import { CampaignView } from './Campaign';
import { command } from '../../state/commands';
import { useState } from 'react';
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
      <div className={s['reportHead']}>
        <span className={s['pill']} data-weekly={result.weekly ? 'true' : undefined}>
          {result.weekly ? r.updatingWeekly : r.reportReady}
        </span>
        <span className={s['mu']}>
          {[
            body.period,
            body.sources.length > 0 ? fill(r.sources, { sources: body.sources.join(' and ') }) : null,
            body.asOf === undefined ? null : fill(r.readAt, { when: body.asOf }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className={s['push']} />
        <PdfButton sessionId={result.id as SessionId} />
      </div>
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
      {body.trend === undefined ? null : <Trend trend={body.trend} />}
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
        <p className={s['mu']}>{r.shareLead}</p>
        <span className={s['acts']}>
          <ShareConversation sessionId={result.id as SessionId} messageId={null} />
          <Button
            size="compact"
            inv={result.weekly}
            aria-pressed={result.weekly}
            onClick={() =>
              void command('taskResults.setWeekly', {
                sessionId: result.id as SessionId,
                weekly: !result.weekly,
              })
            }
          >
            {r.keepUpdating}
          </Button>
        </span>
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

/** This period as a line, the one before dashed under it: one scale for both. */
function Trend({ trend: t }: { trend: NonNullable<ReportResult['trend']> }) {
  const r = copy.one.results;
  const all = [...t.current, ...(t.previous ?? [])];
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const pts = (xs: number[]) =>
    xs
      .map(
        (v, i) =>
          `${xs.length === 1 ? 0 : (i / (xs.length - 1)) * 600},${150 - ((v - min) / (max - min || 1)) * 140 - 5}`,
      )
      .join(' ');
  const prev = t.previous !== undefined && t.previous.length > 1;
  return (
    <figure className={s['trend']}>
      <figcaption className={s['h']}>
        {t.title}
        <span className={s['mu']}> {prev ? r.trendBoth : r.trendOne}</span>
      </figcaption>
      <svg viewBox="0 -2 600 180" role="img" aria-label={t.title} preserveAspectRatio="none">
        {prev && t.previous !== undefined ? (
          <polyline className={s['trendPrev']} points={pts(t.previous)} />
        ) : null}
        <polyline className={s['trendCur']} points={pts(t.current)} />
      </svg>
      <div className={s['trendLabels']} aria-hidden="true">
        {t.labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
    </figure>
  );
}

/** Download PDF: main prints the report page and asks where to save it. */
function PdfButton({ sessionId }: { sessionId: SessionId }) {
  const r = copy.one.results;
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'failed'>('idle');
  const save = async () => {
    setState('busy');
    const res = await command('taskResults.pdf', { sessionId });
    setState(!res.ok ? 'failed' : res.value.path === null ? 'idle' : 'saved');
  };
  return (
    <span className={s['acts']}>
      <Button size="compact" disabled={state === 'busy'} onClick={() => void save()}>
        {r.pdf}
      </Button>
      {state === 'saved' ? (
        <span className={s['mu']} role="status">
          {r.pdfSaved}
        </span>
      ) : state === 'failed' ? (
        <span className={s['error']} role="alert">
          {r.pdfFailed}
        </span>
      ) : null}
    </span>
  );
}
