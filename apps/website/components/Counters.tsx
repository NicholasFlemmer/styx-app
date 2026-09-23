'use client';

import { reached, waitingOnYou } from '@/lib/demo-script';
import { useDemo } from './demo/DemoContext';
import styles from './Counters.module.css';

const pad = (n: number): string => n.toString().padStart(2, '0');

/** The Home screen's counters, following the grant playing in the hero above. */
export const Counters = () => {
  const { step } = useDemo();
  const waiting = waitingOnYou(step);
  const granted = reached(step, 'granted');
  const cells: ReadonlyArray<readonly [label: string, value: number, on: boolean]> = [
    ['Needs you', waiting ? 1 : 0, waiting],
    ['Agents working', waiting ? 2 : 3, false],
    ['Grants active', granted ? 3 : 2, false],
    ['Projects', 5, false],
  ];
  return (
    <section className={styles.strip} aria-label="Home counters, following the demo">
      <div className={`wrap ${styles.cells}`}>
        {cells.map(([label, value, on]) => (
          <div key={label} className={styles.cell} data-on={on ? 'true' : undefined}>
            <span className={styles.num}>{pad(value)}</span>
            <span className={styles.lbl}>
              <span
                className="sq"
                data-on={on ? 'true' : undefined}
                data-hollow={on ? undefined : 'true'}
                aria-hidden="true"
              />
              {label}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
};
