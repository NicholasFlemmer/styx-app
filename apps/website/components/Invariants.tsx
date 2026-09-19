import { Section } from './Section';
import styles from './Invariants.module.css';

const rows = [
  [
    'Keep your passwords anywhere but your computer’s own secure storage.',
    'Keys live in the Mac keychain or Windows credential store, nowhere else. Not in a file, not in a log, not in the app’s own database.',
  ],
  [
    'Let anything reach production without you.',
    'Deploying, or changing live data, asks for Touch ID or Windows Hello first. Every time.',
  ],
  [
    'Give an agent a permanent key.',
    'Every pass is temporary and covers only what you approved. When it runs out, the agent is back to asking.',
  ],
  [
    'Erase the record.',
    'Every request and approval is logged in a way that cannot be edited or deleted. Taking a pass away adds a line.',
  ],
  [
    'Send anything to us.',
    'There is no account and no Styx server. Everything runs on your computer, and your agents talk to your services directly.',
  ],
] as const;

export const Invariants = () => (
  <Section
    id="security"
    title="What Styx will never do."
    lede="An oath sworn on the Styx could not be broken, even by a god. These are ours, built into the software rather than written in a policy."
  >
    <ul className={styles.rows}>
      {rows.map(([claim, detail]) => (
        <li key={claim}>
          <h3>{claim}</h3>
          <p>{detail}</p>
        </li>
      ))}
    </ul>
  </Section>
);
