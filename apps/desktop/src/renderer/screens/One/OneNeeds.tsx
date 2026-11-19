import { copy, oneNeeds, policyRuleText, type ReadModel } from '@styx/core';
import { Button } from '@styx/ui';
import { useCopyPlatform, useModel, useNow, useUi } from '../../state/hooks';
import { policiesInOrder } from '../Approvals/approvals-data';
import { NeedList } from './parts';
import s from './One.module.css';

const identity = (m: ReadModel) => m;

/** Needs your OK (mockup frame 7): one queue for everything risky, and the rules behind it in plain sentences. */
export function OneNeeds() {
  const model = useModel(identity);
  const now = useNow();
  const platform = useCopyPlatform();
  const pushOverlay = useUi((u) => u.pushOverlay);
  const n = copy.one.needs;
  const policies = policiesInOrder(model);
  return (
    <div className={s['page']} data-one-page="needs">
      <h1 className={s['title']}>{n.title}</h1>
      <div className={s['grid2']}>
        <section>
          <NeedList needs={oneNeeds(model, now)} />
        </section>
        <section className={s['box']} aria-label={n.rules}>
          <div className={s['head']}>
            <h2 className={s['h3']}>{n.rules}</h2>
            <Button
              className={s['push']}
              onClick={() => pushOverlay({ kind: 'modal', modal: 'policy-rule' })}
            >
              {n.addRule}
            </Button>
          </div>
          <p className={s['lead']}>{n.rulesLead}</p>
          {policies.length === 0 ? (
            <p className={s['empty']}>{n.noRules}</p>
          ) : (
            <ul className={s['lines']}>
              {policies.map((p) => (
                <li key={p.id} className={s['line']}>
                  <span className={s['lineText']}>{policyRuleText(p, platform)}</span>
                  <Button
                    variant="ghost"
                    aria-label={`${n.editRule} · ${policyRuleText(p, platform)}`}
                    onClick={() => pushOverlay({ kind: 'modal', modal: 'policy-rule', policyId: p.id })}
                  >
                    {n.editRule}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
