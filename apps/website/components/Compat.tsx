import { Section } from './Section';
import styles from './Compat.module.css';

const agents = [
  ['Claude Code', 'Chat with it inside Styx, approve its plans, answer its questions.'],
  ['Codex', 'Same chat, same approvals.'],
  ['Gemini CLI', 'Same chat, same approvals.'],
  ['Cursor', 'Same chat, same approvals.'],
  ['Your terminal', 'A plain shell, with the same rules about what it can reach.'],
] as const;

const editors = [
  ['VS Code', 'Recent folders, keybindings, theme and font come along.'],
  ['Cursor', 'Same as VS Code: recents, keybindings, theme and font.'],
  ['Windsurf', 'Same as VS Code: recents, keybindings, theme and font.'],
  ['JetBrains IDEs', 'WebStorm, IntelliJ IDEA, PyCharm, GoLand, RustRover. Recent projects come along.'],
  ['Zed', 'Detected and ready under “Open in”.'],
  ['Neovim', 'Detected and ready under “Open in”.'],
] as const;

const targets = [
  ['Vercel', 'Deploys and previews.'],
  ['AWS', 'Anything you can reach with the aws command.'],
  ['Google Cloud', 'Anything you can reach with gcloud.'],
  ['Supabase', 'Your databases, live and staging.'],
  ['GitHub', 'Repos, pull requests, releases.'],
  ['Your servers', 'Over SSH, using the identity already on your computer.'],
] as const;

export const Compat = () => (
  <Section
    tone="panel"
    id="agents"
    title="Everything you already use, in one place."
    lede="Styx runs the agents you have installed and signs them in for you, connects to the services you are already logged into, and picks up your editor on first launch: recent folders, keybindings and theme come along, and anything can be opened back in it with one key. Nothing in your editor changes."
  >
    <div className={styles.cols}>
      <div className={styles.col}>
        <h3>Your editor</h3>
        <ul className={styles.rows}>
          {editors.map(([name, how]) => (
            <li key={name}>
              <span className={styles.name}>{name}</span>
              <span className={styles.how}>{how}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.col}>
        <h3>Agents</h3>
        <ul className={styles.rows}>
          {agents.map(([name, how]) => (
            <li key={name}>
              <span className={styles.name}>{name}</span>
              <span className={styles.how}>{how}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.col}>
        <h3>Things agents have to ask for</h3>
        <ul className={styles.rows}>
          {targets.map(([name, how]) => (
            <li key={name}>
              <span className={styles.name}>{name}</span>
              <span className={styles.how}>{how}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  </Section>
);
