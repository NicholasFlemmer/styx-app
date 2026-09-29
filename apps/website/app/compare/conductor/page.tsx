import type { Metadata } from 'next';
import { LegalPage } from '@/components/Legal';
import { site } from '@/lib/site';

/**
 * Styx vs Conductor: the closest product to Styx, compared fairly. Every Conductor fact below is from its own
 * site or docs as of CHECKED, and the sources are linked at the bottom; where Conductor is ahead, the page says so.
 * Re-check before editing: both products move fast.
 */
const CHECKED = '29 September 2026';

export const metadata: Metadata = {
  title: { absolute: 'Styx vs Conductor: Mac apps for running coding agents' },
  description:
    'Styx and Conductor both run Claude Code and Codex in parallel on your Mac. How they differ: projects, production access, audit log, cloud and teams.',
  alternates: { canonical: '/compare/conductor' },
  openGraph: {
    title: 'Styx vs Conductor',
    description: 'Two Mac apps for running coding agents in parallel, compared fairly.',
    url: '/compare/conductor',
  },
};

const FAQ: { q: string; a: string }[] = [
  {
    q: 'Is Styx a Conductor alternative?',
    a: 'Yes. Both are Mac apps that run coding agents like Claude Code and Codex in parallel, each in its own git worktree. Styx adds every project in one window and a gate on production access; Conductor adds cloud workspaces and team collaboration.',
  },
  {
    q: 'What is an agentic development environment (ADE)?',
    a: 'An app for managing AI agents that write code, rather than for writing code yourself: several agents in parallel, each isolated on its own branch, with a place to see who needs you and to review what they did. Warp coined the term in June 2025. Styx and Conductor are both ADEs.',
  },
  {
    q: 'Do I need new subscriptions to use either?',
    a: 'No. Both use the agent logins you already have, such as a Claude or ChatGPT subscription. Styx is free; Conductor is free for local use, with paid plans for cloud workspaces and teams.',
  },
  {
    q: 'Can I use both?',
    a: 'Yes. Both work on ordinary git worktrees and branches in your own repositories, so neither locks your work in.',
  },
];

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
};

const Summary = () => (
  <ul>
    <li>Both run Claude Code, Codex and Cursor agents in parallel on a Mac, each in its own worktree.</li>
    <li>Styx puts every project in one window and makes agents ask before they touch production.</li>
    <li>
      Conductor has cloud workspaces, team collaboration and a Linear integration; Styx has none of those.
    </li>
    <li>Both are free to start and use your existing agent subscriptions.</li>
  </ul>
);

const rows: [string, string, string][] = [
  ['Runs on', 'Mac (Apple silicon); Windows coming', 'Mac'],
  ['Agents', 'Claude Code, Codex, Gemini CLI, Cursor', 'Claude Code, Codex, Cursor, OpenCode'],
  ['Price', 'Free', 'Free locally; Pro $50/month, Teams $60/user/month'],
  ['Each agent isolated', 'Own git worktree and branch', 'Own workspace, worktree and branch'],
  ['Scope of one window', 'Every project you work on', 'Workspaces across the repositories you add'],
  [
    'Review',
    'Diff with per-hunk accept and reject; checks before landing',
    'Diff viewer, pull requests, merge, checks',
  ],
  ['Your editor', 'Imports recents, keybindings and theme; opens files back in it', 'Not part of its docs'],
  [
    'Secrets',
    'In the macOS Keychain; agents get scoped, expiring access',
    'Env vars and a .env in the project, readable by agents',
  ],
  [
    'Production access',
    'Agents ask; you approve for a set time; Touch ID for live systems',
    'Not part of its docs',
  ],
  ['Audit log', 'Every request, approval and use, append-only', 'Not part of its docs'],
  ['Deploy targets', 'Vercel, AWS, Google Cloud, Supabase, GitHub, SSH', 'Not part of its docs'],
  ['Cloud workspaces', 'No: everything runs on your Mac', 'Yes, on Pro and above'],
  ['Team collaboration', 'No', 'Multiplayer on Pro; Teams plan'],
  ['Issue tracker', 'No', 'Starts work from Linear issues'],
];

export default function ConductorPage() {
  return (
    <LegalPage
      title="Styx vs Conductor"
      meta={`Checked ${CHECKED}`}
      summaryLabel="The short version"
      summary={<Summary />}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema).replace(/</g, '\\u003c') }}
      />
      <p>
        Styx and Conductor are both agentic development environments (ADEs): Mac apps for running several
        coding agents at once, each on its own branch, without them tripping over each other or you. If that
        is all you need, either will do it well. They differ in what surrounds the agents.
      </p>

      <h2>Side by side</h2>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Styx</th>
            <th>Conductor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, styx, conductor]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{styx}</td>
              <td>{conductor}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        &ldquo;Not part of its docs&rdquo; means we could not find it in Conductor&apos;s documentation on{' '}
        {CHECKED}, not that it can never be done with it. Tell us at{' '}
        <a href={`mailto:${site.email}`}>{site.email}</a> if something here is wrong and we will fix it.
      </p>

      <h2>Where Conductor is ahead</h2>
      <ul>
        <li>
          <strong>Cloud workspaces.</strong> Agents can run on Conductor&apos;s machines, so work carries on
          with your laptop closed. Styx runs everything on your Mac.
        </li>
        <li>
          <strong>Teams.</strong> Conductor has live collaboration and an admin portal. Styx is for one person
          today.
        </li>
        <li>
          <strong>Linear.</strong> Conductor can start a workspace straight from a Linear issue.
        </li>
        <li>
          <strong>OpenCode.</strong> Conductor runs it; Styx runs Gemini CLI instead.
        </li>
      </ul>

      <h2>Where Styx is different</h2>
      <h3>Every project, one window</h3>
      <p>
        Styx is built around switching between everything you work on: each project, its agents and the ones
        waiting on you, one keystroke apart. Nothing is organised around a single repository.
      </p>
      <h3>Agents never hold your keys</h3>
      <p>
        Useful agents need real things: a deploy, a database, a server. In Styx the credentials stay in your
        Mac&apos;s Keychain. When an agent wants production, it stops and asks; you approve it for a set time,
        with Touch ID for anything live, and the access ends on its own. Every request, approval and use goes
        into a log nobody can edit.
      </p>
      <h3>On top of your editor</h3>
      <p>
        Styx brings in your editor&apos;s recent projects, keybindings and theme, and opens any file back in
        it with one key. It is not trying to be the place you write code.
      </p>
      <p>
        One honest limit: this is a guardrail, not a sandbox. Agents run as you, on your Mac, and an agent
        that deliberately goes around Styx&apos;s tools is not stopped by them.
      </p>

      <h2>Which to choose</h2>
      <p>
        Choose <strong>Conductor</strong> if you want agents running in the cloud, work as a team, or start
        tasks from Linear. Choose <strong>Styx</strong> if you work across several projects and want your
        agents near production without handing them the keys.
      </p>
      <p>
        <a href={site.links.downloadMac}>Download Styx for Mac</a>. It is free.
      </p>

      <h2>Questions</h2>
      {FAQ.map((f) => (
        <div key={f.q}>
          <h3>{f.q}</h3>
          <p>{f.a}</p>
        </div>
      ))}

      <h2>Sources</h2>
      <ul>
        <li>
          <a href="https://www.conductor.build/">conductor.build</a>,{' '}
          <a href="https://www.conductor.build/docs/">its docs</a> and{' '}
          <a href="https://www.conductor.build/pricing">pricing</a>
        </li>
        <li>
          Conductor&apos;s{' '}
          <a href="https://www.conductor.build/docs/reference/environment-variables">environment variables</a>{' '}
          and <a href="https://docs.conductor.build/tips/using-multiple-repos">multiple repositories</a> docs
        </li>
        <li>
          <a href="https://www.warp.dev/blog/reimagining-coding-agentic-development-environment">
            Warp 2.0, the Agentic Development Environment
          </a>
        </li>
      </ul>
    </LegalPage>
  );
}
