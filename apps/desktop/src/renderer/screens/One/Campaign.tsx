import {
  copy,
  fill,
  formatMoney,
  launchCap,
  type CampaignAd,
  type CampaignLive,
  type CampaignResult,
  type ProjectId,
  type SessionId,
  type TaskResult,
} from '@styx/core';
import { Button } from '@styx/ui';
import { useCallback, useEffect, useState } from 'react';
import { useSpawnForm } from '../../features/modals/use-spawn-form';
import { command } from '../../state/commands';
import { useNow, useUi } from '../../state/hooks';
import s from './Results.module.css';

const DAY = 86_400_000;
/** How often the live view asks Meta again while it is on screen. */
const LIVE_EVERY = 15 * 60_000;

/** Puts the cursor in the task's message box, for "ask for a change". */
const focusComposer = () => document.querySelector<HTMLTextAreaElement>('[data-chat-pane] textarea')?.focus();

/**
 * A campaign (mockup design/next/styx-one-results.html, frames 2–4): a draft the person can change and approve
 * exactly as shown, then the same card as the live view with Pause everything, then what it did.
 */
export function CampaignView({ result, body }: { result: TaskResult; body: CampaignResult }) {
  return result.launchApprovedAt === null || result.approved === null ? (
    <Draft key={result.updatedAt} result={result} body={body} />
  ) : (
    <Live result={result} body={body} approved={result.approved} />
  );
}

interface Edit {
  headline: string;
  body: string;
  picked: boolean;
}

function Draft({ result, body }: { result: TaskResult; body: CampaignResult }) {
  const r = copy.one.results;
  const plan = body.launch;
  const [ads, setAds] = useState<Edit[]>(() =>
    body.ads.map((a) => ({ headline: a.headline, body: a.body, picked: a.picked })),
  );
  const [editing, setEditing] = useState<number | null>(null);
  const [perDay, setPerDay] = useState(String(plan?.perDay ?? ''));
  const [days, setDays] = useState(String(plan?.days ?? ''));
  const [countries, setCountries] = useState((plan?.countries ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = ads.filter((a) => a.picked).length;
  const amount = Number(perDay);
  const length = Number.parseInt(days, 10);
  const codes = countries
    .split(/[\s,]+/)
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c !== '');
  const valid =
    plan !== undefined &&
    picked > 0 &&
    Number.isFinite(amount) &&
    amount > 0 &&
    Number.isInteger(length) &&
    length >= 1 &&
    length <= 90 &&
    codes.every((c) => /^[A-Z]{2}$/.test(c)) &&
    ads.every((a) => !a.picked || (a.headline.trim() !== '' && a.body.trim() !== ''));
  const approve = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    const res = await command('taskResults.approveLaunch', {
      sessionId: result.id as SessionId,
      seenAt: result.updatedAt,
      ads: ads.flatMap((a, index) =>
        a.picked ? [{ index, headline: a.headline.trim(), body: a.body.trim() }] : [],
      ),
      perDay: amount,
      days: length,
      countries: codes.length > 0 ? codes : null,
    });
    setBusy(false);
    if (!res.ok) setError(res.error.message);
  };
  const set = (i: number, p: Partial<Edit>) =>
    setAds((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <article className={s['paper']} data-one-result="campaign" aria-label={body.title}>
      {body.lookedAt.length > 0 ? (
        <section aria-label={r.lookedAt}>
          <h3 className={s['h']}>{r.lookedAt}</h3>
          <ul className={s['steps']}>
            {body.lookedAt.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {body.summary === undefined ? null : <p className={s['lede']}>{body.summary}</p>}
      <section aria-label={r.ads}>
        <h3 className={s['h']}>{r.ads}</h3>
        <ul className={s['ads']}>
          {body.ads.map((ad, i) => {
            const e = ads[i];
            if (e === undefined) return null;
            return (
              <li key={i} className={s['adItem']} data-picked={e.picked ? 'true' : undefined}>
                <AdPreview
                  sessionId={result.id as SessionId}
                  index={i}
                  ad={ad}
                  page={body.page ?? null}
                  headline={e.headline}
                  text={e.body}
                  editing={editing === i}
                  onHeadline={(v) => set(i, { headline: v })}
                  onText={(v) => set(i, { body: v })}
                />
                <span className={s['adFoot']}>
                  <span className={s['mu']}>{ad.estimate ?? ''}</span>
                  <Button
                    size="compact"
                    inv={e.picked}
                    aria-pressed={e.picked}
                    onClick={() => set(i, { picked: !e.picked })}
                  >
                    {e.picked ? r.picked : r.pick}
                  </Button>
                  <Button
                    size="compact"
                    aria-pressed={editing === i}
                    aria-label={`${editing === i ? r.doneEditing : r.edit} · ${e.headline}`}
                    onClick={() => setEditing(editing === i ? null : i)}
                  >
                    {editing === i ? r.doneEditing : r.edit}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      </section>
      {plan === undefined ? null : (
        <section className={s['plan']} aria-label={r.approve} data-one-launch="open">
          <div className={s['planFields']}>
            <label className={s['field']}>
              <span>{fill(r.perDayIn, { currency: plan.currency })}</span>
              <input inputMode="decimal" value={perDay} onChange={(e) => setPerDay(e.target.value)} />
            </label>
            <label className={s['field']}>
              <span>{r.daysLabel}</span>
              <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
            </label>
            <label className={`${s['field']} ${s['wide']}`}>
              <span>{r.countriesLabel}</span>
              <input value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="ZA" />
            </label>
            <span className={s['field']}>
              <span>{r.who}</span>
              <span className={s['fixed']}>{plan.audience}</span>
            </span>
          </div>
          <b className={s['launchWhat']} aria-live="polite">
            {valid
              ? fill(r.launchSummary, {
                  n: picked,
                  cap: formatMoney(launchCap({ ...plan, perDay: amount, days: length }), plan.currency),
                  perDay: formatMoney(amount, plan.currency),
                  days: length,
                })
              : picked === 0
                ? copy.one.results.noPicks
                : r.fixFields}
          </b>
          <span className={s['mu']}>{r.launchFine}</span>
          <span className={s['acts']}>
            <Button variant="accent" size="regular" disabled={busy || !valid} onClick={() => void approve()}>
              {r.approve}
            </Button>
            <Button size="regular" onClick={focusComposer}>
              {r.change}
            </Button>
            <span className={s['mu']}>{r.approveAuth}</span>
          </span>
          {error === null ? null : (
            <span role="alert" className={s['error']}>
              {error}
            </span>
          )}
        </section>
      )}
    </article>
  );
}

/** One ad drawn as it appears in the feed: the Page, the text, the picture, the headline and the button. */
function AdPreview({
  sessionId,
  index,
  ad,
  page,
  headline,
  text,
  editing,
  onHeadline,
  onText,
}: {
  sessionId: SessionId;
  index: number;
  ad: CampaignAd;
  page: string | null;
  headline: string;
  text: string;
  editing: boolean;
  onHeadline?: (v: string) => void;
  onText?: (v: string) => void;
}) {
  const r = copy.one.results;
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    if (ad.image === undefined) return;
    let live = true;
    void command('taskResults.adImage', { sessionId, index }).then((res) => {
      if (live && res.ok) setImage(res.value.dataUrl);
    });
    return () => {
      live = false;
    };
  }, [sessionId, index, ad.image]);
  const host = (() => {
    try {
      return ad.link === undefined ? null : new URL(ad.link).host.replace(/^www\./, '').toUpperCase();
    } catch {
      return null;
    }
  })();
  return (
    <div className={s['feed']} aria-label={fill(r.adPreview, { product: ad.product })}>
      <div className={s['feedHead']}>
        <span className={s['feedAvatar']} aria-hidden="true" />
        <span>
          <b>{page ?? ad.product}</b>
          <span className={s['mu']}>{r.sponsored}</span>
        </span>
      </div>
      {editing && onText !== undefined ? (
        <textarea
          className={s['feedEdit']}
          aria-label={r.adText}
          value={text}
          maxLength={400}
          onChange={(e) => onText(e.target.value)}
        />
      ) : (
        <p className={s['feedText']}>{text}</p>
      )}
      {image === null ? (
        <div className={s['feedImage']} aria-label={fill(r.noImage, { product: ad.product })} role="img">
          {fill(r.noImage, { product: ad.product })}
        </div>
      ) : (
        <img className={s['feedImg']} src={image} alt={fill(r.adImage, { product: ad.product })} />
      )}
      <div className={s['feedFoot']}>
        <span className={s['feedFootText']}>
          {host === null ? null : <span className={s['mu']}>{host}</span>}
          {editing && onHeadline !== undefined ? (
            <input
              className={s['feedEditLine']}
              aria-label={r.adHeadline}
              value={headline}
              maxLength={120}
              onChange={(e) => onHeadline(e.target.value)}
            />
          ) : (
            <b>{headline}</b>
          )}
        </span>
        <span className={s['feedCta']}>{ad.cta ?? r.shopNow}</span>
      </div>
    </div>
  );
}

/** After approval: what it is spending and earning, Pause everything, then what it did once it ends. */
function Live({
  result,
  body,
  approved,
}: {
  result: TaskResult;
  body: CampaignResult;
  approved: NonNullable<TaskResult['approved']>;
}) {
  const r = copy.one.results;
  const now = useNow(60_000);
  const plan = approved.plan;
  const cap = launchCap(plan);
  const [live, setLive] = useState<CampaignLive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [tick, setTick] = useState(0);
  const read = useCallback(() => setTick((n) => n + 1), []);
  // Meta is asked when the view opens, every 15 minutes while it stays open, and on Refresh.
  useEffect(() => {
    if (result.campaignId === null) return;
    let alive = true;
    void command('taskResults.live', { sessionId: result.id as SessionId }).then((res) => {
      if (!alive) return;
      if (res.ok) {
        setLive(res.value.live);
        setError(null);
      } else setError(res.error.message);
    });
    const t = setTimeout(read, LIVE_EVERY);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [result.id, result.campaignId, tick, read]);
  const approvedAt = result.launchApprovedAt ?? now;
  const day = Math.min(plan.days, Math.max(1, Math.ceil((now - approvedAt) / DAY)));
  const ended = live?.status === 'ended' || now > approvedAt + (plan.days + 1) * DAY;
  const paused = result.pausedAt !== null || live?.status === 'paused';
  const state = result.campaignId === null ? 'launching' : ended ? 'ended' : paused ? 'paused' : 'live';
  const pause = async () => {
    setPausing(true);
    const res = await command('taskResults.pauseAll', { sessionId: result.id as SessionId });
    setPausing(false);
    if (!res.ok) setError(res.error.message);
    else read();
  };
  const money = (n: number) => formatMoney(n, plan.currency);
  return (
    <article
      className={s['paper']}
      data-one-result="campaign"
      data-one-campaign-state={state}
      aria-label={body.title}
    >
      <div className={s['liveHead']}>
        <span className={s['pill']} data-on={state === 'live' ? 'true' : undefined}>
          {r.states[state]}
        </span>
        <span className={s['mu']}>
          {state === 'live' || state === 'paused'
            ? fill(r.dayOf, { day, days: plan.days })
            : state === 'launching'
              ? r.launching
              : fill(r.endedOn, { days: plan.days })}
          {live === null
            ? ''
            : ` · ${fill(r.readAgo, {
                when: new Date(live.readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              })}`}
        </span>
        <span className={s['push']} />
        {state === 'live' || state === 'launching' ? (
          <button
            type="button"
            className={s['stop']}
            disabled={pausing || result.campaignId === null}
            onClick={() => void pause()}
          >
            {r.pauseAll}
          </button>
        ) : null}
        {result.campaignId !== null ? (
          <Button size="compact" onClick={read}>
            {r.refresh}
          </Button>
        ) : null}
      </div>
      {error === null ? null : (
        <p role="alert" className={s['error']}>
          {error}
        </p>
      )}
      {state === 'ended' && live !== null ? (
        <h2 className={s['headline']}>
          {live.sales === null
            ? fill(r.endedSpent, { spent: money(live.spent) })
            : fill(r.endedSold, {
                spent: money(live.spent),
                sales: money(live.sales),
                times: live.spent > 0 ? (live.sales / live.spent).toFixed(1) : '0',
              })}
        </h2>
      ) : null}
      <div className={s['meterRow']}>
        <span className={s['metricBig']}>
          <span className={s['mu']}>{r.spent}</span>
          <b>{money(live?.spent ?? 0)}</b>
          <span className={s['mu']}>{fill(r.ofCap, { cap: money(cap) })}</span>
        </span>
        <span className={s['meterWrap']}>
          <span
            className={s['meter']}
            role="meter"
            aria-label={r.spent}
            aria-valuemin={0}
            aria-valuemax={cap}
            aria-valuenow={live?.spent ?? 0}
          >
            <span style={{ width: `${Math.min(100, ((live?.spent ?? 0) / cap) * 100)}%` }} />
          </span>
          <span className={s['mu']}>
            {fill(r.ofTheCap, { pct: Math.round(((live?.spent ?? 0) / cap) * 100) })}
          </span>
        </span>
        {live?.sales != null ? (
          <span className={s['metricBig']}>
            <span className={s['mu']}>{r.sales}</span>
            <b>{money(live.sales)}</b>
            <span className={s['mu']}>
              {fill(r.timesCost, { times: live.spent > 0 ? (live.sales / live.spent).toFixed(1) : '0' })}
            </span>
          </span>
        ) : null}
        <span className={s['metricBig']}>
          <span className={s['mu']}>{r.clicks}</span>
          <b>{(live?.clicks ?? 0).toLocaleString()}</b>
        </span>
      </div>
      {live !== null && live.ads.length > 0 ? (
        <div className={s['tableWrap']}>
          <table className={s['table']}>
            <caption className={s['h']}>{r.byAd}</caption>
            <thead>
              <tr>
                <th scope="col">{r.ad}</th>
                <th scope="col">{r.spent}</th>
                <th scope="col">{r.clicks}</th>
                <th scope="col">{r.sales}</th>
              </tr>
            </thead>
            <tbody>
              {live.ads.map((a) => (
                <tr key={a.id}>
                  <th scope="row">{a.name}</th>
                  <td>{money(a.spent)}</td>
                  <td>{a.clicks.toLocaleString()}</td>
                  <td>{a.sales === null ? '—' : money(a.sales)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <section aria-label={r.approvedAds}>
        <h3 className={s['h']}>
          {fill(r.approvedLine, {
            n: approved.ads.length,
            perDay: money(plan.perDay),
            days: plan.days,
            cap: money(cap),
          })}
        </h3>
        <ul className={s['ads']}>
          {approved.ads.map((ad, i) => (
            <li key={i} className={s['adItem']}>
              <AdPreview
                sessionId={result.id as SessionId}
                index={i}
                ad={ad}
                page={body.page ?? null}
                headline={ad.headline}
                text={ad.body}
                editing={false}
              />
            </li>
          ))}
        </ul>
      </section>
      {state === 'ended' ? (
        <AfterwardActions projectId={result.projectId as ProjectId} title={body.title} />
      ) : null}
    </article>
  );
}

/** When a campaign is over: its report, or the same campaign again. */
function AfterwardActions({ projectId, title }: { projectId: ProjectId; title: string }) {
  const r = copy.one.results;
  const { spawn, busy } = useSpawnForm(projectId);
  const openSession = useUi((u) => u.openSession);
  const setScreen = useUi((u) => u.setScreen);
  const start = async (text: string, kind: 'report' | 'campaign') => {
    const id = await spawn(text, kind);
    if (id === null) return;
    openSession(projectId, id);
    setScreen('one-task');
  };
  return (
    <span className={s['acts']}>
      <Button
        size="regular"
        disabled={busy}
        onClick={() => void start(fill(r.reportOn, { title }), 'report')}
      >
        {r.makeReport}
      </Button>
      <Button
        size="regular"
        disabled={busy}
        onClick={() => void start(fill(r.runAgainMsg, { title }), 'campaign')}
      >
        {r.runAgain}
      </Button>
    </span>
  );
}
