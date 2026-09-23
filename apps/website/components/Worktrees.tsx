import { Section } from './Section';
import styles from './Worktrees.module.css';

export const Worktrees = () => (
  <Section
    id="repo"
    title="Agents don't step on each other. Or on you."
    lede="Every agent works on its own copy of your project, on its own branch. You keep working on yours. When something clashes, the agent stops and tells you exactly where."
  >
    <div
      className={styles.tableWrap}
      tabIndex={0}
      role="region"
      aria-label="Who is working on what, scrolls sideways on narrow screens"
    >
      <table className={styles.lanes}>
        <thead>
          <tr>
            <th>Branch</th>
            <th>Who</th>
            <th>Changes</th>
            <th>Pull request</th>
            <th>
              <span className="srOnly">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mono">main</td>
            <td>you</td>
            <td className="mono">—</td>
            <td className="mono">—</td>
            <td />
          </tr>
          <tr>
            <td className="mono">fix/checkout</td>
            <td>Claude</td>
            <td className="mono">+142 −38 · 3 files</td>
            <td className="mono">#214 open</td>
            <td>
              <span className={styles.miniBtn} data-inv="true">
                Review
              </span>
            </td>
          </tr>
          <tr>
            <td className="mono">test/flaky</td>
            <td>Codex</td>
            <td className="mono">+12 −4 · 2 files</td>
            <td className="mono">—</td>
            <td>
              <span className={styles.miniBtn}>Open</span>
            </td>
          </tr>
          <tr>
            <td className="mono">docs/readme</td>
            <td>Gemini</td>
            <td className="mono">
              <span className="tag" data-on="true">
                conflict
              </span>{' '}
              README.md
            </td>
            <td className="mono">—</td>
            <td>
              <span className={styles.miniBtn}>Resolve</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <ul className={styles.facts}>
      <li>
        <strong>Nothing merges on its own.</strong> An agent&apos;s work stays on its branch until you press
        Land, which brings in the latest main, runs your checks and merges it in one step.
      </li>
      <li>
        <strong>Clashes go back to the agent that made them.</strong> It is told what changed underneath it
        and finishes the merge itself. Agents working on the same file are warned before it becomes a clash.
      </li>
      <li>
        <strong>Finished work tidies itself away.</strong> Landed branches archive themselves; agents you mark
        done stay on the board for a week, then go.
      </li>
    </ul>
  </Section>
);
