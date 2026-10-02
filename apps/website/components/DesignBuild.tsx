import { Section } from './Section';
import styles from './DesignBuild.module.css';

/**
 * Tasks, design and build (0.3.2–0.4, discrepancies #138–#140): pictures of the real app over the demo fixture, taken
 * by apps/desktop/e2e/site-shots.spec.ts (`STYX_SITE_SHOTS=1`), so they stay true to the app when it changes.
 */
const rows = [
  {
    id: 'tasks',
    title: 'Every task, one card.',
    body: 'Start as many tasks as you like, each with its own agent on its own branch. The Tasks tab shows each one as a card: what it is doing, whether it needs you, and what it changed. Click a card to open its chat.',
    facts: [
      'Mark a task Design or Build when you start it.',
      'A design and the build that came from it point at each other.',
      'Your turn shows in lime, so the one that needs you is easy to find.',
    ],
    src: '/app/tasks.jpg',
    alt: 'The Tasks tab: cards for a design task, a build task, a flaky test fix and an idle Gemini lane, each with its agent, branch, status and changes, and a card to start another lane as Design or Build',
  },
  {
    id: 'design',
    title: 'Design it before you build it.',
    body: 'A design task draws your screens first, as wireframes or finished designs, at desktop, tablet and phone size, in your own type and colours. Every size sits side by side on one canvas.',
    facts: [
      'Click anything to change its text, colour or corners, or drag over an area.',
      'Or tell the agent: it gets the screen, the element and a picture of it.',
      'Build it hands the screens to a build task, and tells it when the design changes.',
      'Screens are plain files in your repo, reviewed and kept like code.',
    ],
    src: '/app/design.jpg',
    alt: 'The Design tab: a checkout screen at desktop, tablet and phone size, the Pay button selected, and a panel to change its text and colour or tell Codex to make it sticky on phone',
  },
  {
    id: 'preview',
    title: 'Point at what is wrong.',
    body: 'Preview runs your app beside the chat. When something looks off, press Select to fix, click it or drag over an area, and say what is wrong. The agent gets the element, where it lives in your code when the page says, and a picture.',
    facts: [
      'Desktop, tablet and phone sizes.',
      'A design problem goes to the design task instead.',
      'It only shows pages on your own machine. A repo can’t point it anywhere else.',
    ],
    src: '/app/preview.jpg',
    alt: 'Preview: the running checkout page beside the chat, with Fix this naming the Pay button and a note about its hover contrast, ready to send to Claude',
  },
] as const;

export const DesignBuild = () => (
  <Section
    tone="panel"
    id="design"
    title="Design it first. Then point at what's wrong."
    lede="Agents can draw your screens before they write code, and fix what you point at once it runs. Nothing to describe in a paragraph: click it."
  >
    <div className={styles.rows}>
      {rows.map((r, i) => (
        <article key={r.id} className={styles.row} data-flip={i % 2 === 1 || undefined}>
          <div className={styles.copy}>
            <h3>{r.title}</h3>
            <p>{r.body}</p>
            <ul>
              {r.facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
          <figure className={styles.shot}>
            <img src={r.src} width={1600} height={868} loading="lazy" decoding="async" alt={r.alt} />
          </figure>
        </article>
      ))}
    </div>
  </Section>
);
