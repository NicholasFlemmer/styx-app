'use client';

import { useEffect, useRef, useState } from 'react';
import { crossingStepAt, type DemoStep } from '@/lib/demo-script';
import { MockFrame } from './demo/MockFrame';
import { WORKSPACE_FULL, WorkspaceMock } from './demo/WorkspaceMock';
import styles from './CrossingScroller.module.css';

export type CrossingStep = { readonly title: string; readonly body: string };

/** Where the request sits relative to the river at each step of the demo. */
const riverPosition = (step: DemoStep): { left: string; side: 'near' | 'far' } => {
  switch (step) {
    case 'command':
      return { left: '18%', side: 'near' };
    case 'ask':
    case 'sheet':
    case 'mfa':
      return { left: '46%', side: 'near' };
    case 'granted':
      return { left: '58%', side: 'far' };
    case 'logged':
      return { left: '74%', side: 'far' };
  }
};

const RiverStrip = ({ step }: { step: DemoStep }) => {
  const pos = riverPosition(step);
  const waiting = step === 'ask' || step === 'sheet' || step === 'mfa';
  return (
    <div className={styles.river} aria-hidden="true">
      <span className={styles.bankNear}>Your side</span>
      <span className={styles.bankFar}>Production</span>
      <span className={styles.line} />
      <span className={styles.request} data-side={pos.side} data-on={waiting ? 'true' : undefined} style={{ left: pos.left }} />
      {step === 'logged' && <span className={`${styles.landed} mono`}>09:41:07 · granted write to Codex · 1h</span>}
    </div>
  );
};

/**
 * The five steps scroll past on the left; the live workspace on the right follows whichever step is in the
 * middle of the viewport. Step 3 shows the sheet, then Touch ID.
 */
export const CrossingScroller = ({ steps }: { steps: readonly CrossingStep[] }) => {
  const [active, setActive] = useState(0);
  const [mfa, setMfa] = useState(false);
  const itemsRef = useRef<Array<HTMLLIElement | null>>([]);

  useEffect(() => {
    const items = itemsRef.current.filter((el): el is HTMLLIElement => el !== null);
    if (items.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (!hit) return;
        const index = items.indexOf(hit.target as HTMLLIElement);
        if (index >= 0) setActive(index);
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: 0 },
    );
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [steps.length]);

  // While "you decide" is in view, the sheet gives way to the Touch ID moment after a beat.
  const base = crossingStepAt(active);
  useEffect(() => {
    if (base !== 'sheet') return;
    const t = window.setTimeout(() => setMfa(true), 1600);
    return () => {
      window.clearTimeout(t);
      setMfa(false);
    };
  }, [base]);
  const step: DemoStep = base === 'sheet' && mfa ? 'mfa' : base;

  return (
    <div className={styles.layout}>
      <ol className={styles.list}>
        {steps.map((s, i) => (
          <li
            key={s.title}
            ref={(el) => {
              itemsRef.current[i] = el;
            }}
            className={styles.item}
            data-on={i === active ? 'true' : undefined}
          >
            <span className={styles.no}>{(i + 1).toString().padStart(2, '0')}</span>
            <div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className={styles.stage}>
        <div className={styles.sticky}>
          <MockFrame full={WORKSPACE_FULL}>
            <WorkspaceMock step={step} compact={false} chrome="mac" />
          </MockFrame>
          <RiverStrip step={step} />
        </div>
      </div>
    </div>
  );
};
