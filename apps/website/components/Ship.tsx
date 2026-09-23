import { Section } from './Section';
import styles from './Ship.module.css';

/**
 * Everything between an agent finishing and the change being live. Added once the app grew these (discrepancy
 * #117): the site had stopped at "review the branch", and the app had carried on to running, landing,
 * publishing and deploying.
 */
const rows = [
  [
    'See it running.',
    'Styx works out how to start your app and shows it next to the code, at desktop, tablet or phone size. The first time, an agent figures out the command, and Styx remembers it.',
  ],
  [
    'Keep talking while it works.',
    'Type your next message while an agent is busy. It waits for the current turn to finish, or Codex takes it straight away.',
  ],
  [
    'Undo a turn.',
    'Every turn an agent takes is saved. If one goes wrong, put the project back to how it was before it, in one click.',
  ],
  [
    'Publish in one step.',
    'Commit, push and open a pull request together. A project that is not on GitHub yet can be connected from inside Styx.',
  ],
  [
    'Deploy to live.',
    'One button, named for where it goes. It asks for your fingerprint first, the same as it would ask on an agent’s behalf.',
  ],
  [
    'Skills for every agent.',
    'Install a skill once and choose which agents get it: Claude Code, Codex, Gemini CLI, Cursor, or all of them.',
  ],
] as const;

export const Ship = () => (
  <Section
    tone="panel"
    id="ship"
    title="From a finished branch to live, without leaving."
    lede="Once an agent is done, everything else happens in the same window too. Anything that reaches production still asks you first."
  >
    <ul className={styles.rows}>
      {rows.map(([claim, detail]) => (
        <li key={claim}>
          <h3>{claim}</h3>
          <p>{detail}</p>
        </li>
      ))}
    </ul>
    <p className={styles.also}>
      Also in the app: a usage view that shows how close each agent is to its limit, background reviews of a
      project’s technical debt, and an agent dock that keeps every chat above your other windows.
    </p>
  </Section>
);
