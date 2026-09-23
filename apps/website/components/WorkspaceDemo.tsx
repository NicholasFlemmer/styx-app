'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { demoDurations, demoStepDescriptions, demoStepLabels, demoSteps, nextStep } from '@/lib/demo-script';
import { useDemo } from './demo/DemoContext';
import { MockFrame } from './demo/MockFrame';
import { WORKSPACE_COMPACT, WORKSPACE_FULL, WorkspaceMock } from './demo/WorkspaceMock';
import styles from './WorkspaceDemo.module.css';

const subscribeReducedMotion = (onChange: () => void) => {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
};
const readReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const WorkspaceDemo = () => {
  const { step, setStep, playing, setPlaying, chrome, setChrome } = useDemo();
  const [inView, setInView] = useState(false);
  const figureRef = useRef<HTMLElement>(null);
  const reduced = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false);

  useEffect(() => {
    const el = figureRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting)), {
      threshold: 0.2,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Plays on its own whenever it is on screen; Pause is the only stop. Picking a step jumps there and keeps going.
  const autoplay = playing && inView && !reduced;
  useEffect(() => {
    if (!autoplay) return;
    const t = window.setTimeout(() => setStep((s) => nextStep(s)), demoDurations[step]);
    return () => window.clearTimeout(t);
  }, [autoplay, step, setStep]);

  return (
    <figure ref={figureRef} className={styles.figure}>
      <MockFrame full={WORKSPACE_FULL} compact={WORKSPACE_COMPACT}>
        {(compact) => <WorkspaceMock step={step} compact={compact} chrome={chrome} />}
      </MockFrame>
      <figcaption className={styles.controls}>
        <ol className={styles.steps} aria-label="Grant flow steps">
          {demoSteps.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className={styles.step}
                data-on={s === step ? 'true' : undefined}
                aria-pressed={s === step}
                onClick={() => setStep(s)}
              >
                <span className="sq" data-on={s === step ? 'true' : undefined} aria-hidden="true" />
                <span className={styles.stepNo}>{i + 1}</span>
                <span className={styles.stepLabel}>{demoStepLabels[s]}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className={styles.chrome} role="group" aria-label="Window chrome">
          <button
            type="button"
            className={styles.chromeBtn}
            data-inv={chrome === 'mac' ? 'true' : undefined}
            aria-pressed={chrome === 'mac'}
            onClick={() => setChrome('mac')}
          >
            Mac
          </button>
          <button
            type="button"
            className={styles.chromeBtn}
            data-inv={chrome === 'win' ? 'true' : undefined}
            aria-pressed={chrome === 'win'}
            onClick={() => setChrome('win')}
          >
            Windows
          </button>
        </div>
        <button
          type="button"
          className={styles.play}
          onClick={() => setPlaying((p) => !p)}
          aria-pressed={playing}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <p className="srOnly" aria-live="polite">
          {demoStepDescriptions[step]}
        </p>
      </figcaption>
    </figure>
  );
};
