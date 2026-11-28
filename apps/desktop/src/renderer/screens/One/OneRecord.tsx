import { copy, oneRecord, type ReadModel } from '@styx/core';
import { env } from '../../state/bridge';
import { useModel, useNow, useUi } from '../../state/hooks';
import { clockOffsetMinutes } from '../Approvals/approvals-data';
import s from './One.module.css';

const identity = (m: ReadModel) => m;

/** The record (mockup frame 10): the append-only audit log, in sentences. A line opens its entry. */
export function OneRecord() {
  const model = useModel(identity);
  const now = useNow();
  const pushOverlay = useUi((u) => u.pushOverlay);
  const lines = oneRecord(model, now, clockOffsetMinutes(typeof env().now === 'number', now));
  const r = copy.one.record;
  return (
    <div className={s['page']} data-one-page="record">
      <h1 className={s['title']}>{r.title}</h1>
      <p className={s['lead']}>{r.lead}</p>
      {lines.length === 0 ? (
        <p className={s['empty']}>{r.empty}</p>
      ) : (
        <ul className={s['lines']}>
          {lines.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                className={`${s['line']} ${s['recordLine']}`}
                onClick={() => pushOverlay({ kind: 'drawer', drawer: 'audit', auditId: l.id })}
              >
                <span className={s['lineText']}>{l.sentence}</span>
                <span className={s['lineTime']}>{l.time}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
