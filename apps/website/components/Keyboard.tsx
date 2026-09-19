import tokens from '@styx/tokens/tokens.json';
import { Section } from './Section';
import { Shortcut } from './Shortcut';
import styles from './Keyboard.module.css';

const s = tokens.shortcuts;

const rows: ReadonlyArray<readonly [chords: readonly string[], what: string]> = [
  [[s.palette], 'Open the command bar: switch, start an agent, deploy, approve'],
  [[s.switchProject], 'Switch project'],
  [[s.focusAgent], "Jump to an agent's chat"],
  [[s.spawnAgent], 'Start a new agent'],
  [[s.approve], 'Approve the request in front of you'],
  [[s.deny], 'Turn it down'],
  [[s.diffAccept, s.diffReject], 'Keep or drop a change'],
  [[s.diffNext, s.diffPrev], 'Next or previous change'],
  [[s.diffDone], 'Finish reviewing'],
  [[s.popoutChat], 'Pop a chat out into its own window'],
  [[s.toggleTheme], 'Switch light and dark. Works on this page too.'],
  [[s.close], 'Close whatever is open'],
];

export const Keyboard = () => (
  <Section
    tone="panel"
    id="keyboard"
    title="Fast, if you want it to be."
    lede="Everything has a key. The command bar is where you start when you don't know which one."
  >
    <ul className={styles.rows}>
      {rows.map(([chords, what]) => (
        <li key={what}>
          <span className={styles.keys}>
            {chords.map((chord) => (
              <Shortcut key={chord} chord={chord} />
            ))}
          </span>
          <span>{what}</span>
        </li>
      ))}
    </ul>
  </Section>
);
