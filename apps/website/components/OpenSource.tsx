import { site } from '@/lib/site';
import { Section } from './Section';
import styles from './OpenSource.module.css';

const ways = [
  {
    title: 'Read the code',
    text: 'All of it is on GitHub, including the rules that decide what an agent may reach and the audit log that records it. Build it yourself with Node, pnpm and git.',
    href: site.links.github,
    label: 'Styx on GitHub ↗',
    external: true,
  },
  {
    title: 'Add an agent',
    text: 'Styx runs Claude Code, Codex, Gemini CLI and Cursor’s agent. The guide covers teaching it another one, from finding the CLI to the tests a pull request needs.',
    href: site.links.addAgent,
    label: 'Read the guide',
    external: false,
  },
  {
    title: 'Add a deploy target',
    text: 'Vercel, AWS, Google Cloud, Supabase, GitHub and SSH today. The guide shows how a new provider gets the same asks, time limits and record as the rest.',
    href: site.links.addTarget,
    label: 'Read the guide',
    external: false,
  },
] as const;

/** Free and open source (Apache-2.0): where the code is, the two ways to extend it, and where to talk. */
export const OpenSource = () => (
  <Section
    id="source"
    title="Open source."
    lede="Styx is free and open source under the Apache License 2.0. Read how it works, build it yourself, or help it reach more agents and more places to deploy."
  >
    <ul className={styles.cards}>
      {ways.map((w) => (
        <li key={w.title} className={styles.card}>
          <h3>{w.title}</h3>
          <p className={styles.meta}>{w.text}</p>
          <a
            className="btn"
            href={w.href}
            {...(w.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {w.label}
          </a>
        </li>
      ))}
    </ul>
    <p className={styles.note}>
      Questions, ideas and things you built go in <a href={site.links.discussions}>GitHub Discussions</a>.
      Bugs go in <a href={`${site.links.github}/issues`}>issues</a>.
    </p>
  </Section>
);
