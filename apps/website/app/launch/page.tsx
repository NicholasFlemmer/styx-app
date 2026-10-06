import type { Metadata } from 'next';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { DownloadButton } from '@/components/DownloadButton';
import { site } from '@/lib/site';
import styles from './Launch.module.css';

/**
 * The launch article (30 September 2026): who makes Styx, why, what it does, how it was built, where it stops,
 * and what's next — in Nic's own voice. Linked from the top nav as Launch.
 */
const PUBLISHED = '2026-09-30';
const PUBLISHED_WORDS = '30 September 2026';
const UPDATED = '2026-10-06';

export const metadata: Metadata = {
  title: { absolute: 'Introducing Styx: every project, every agent, every key, one window' },
  description:
    'Why I built Styx, a free, open-source app for running Claude Code, Codex, Gemini and Cursor across all your projects, with agents that ask before they touch production.',
  alternates: { canonical: '/launch' },
  openGraph: {
    title: 'Introducing Styx',
    description: 'Every project, every agent, every key, one window. Why I built it, and what it does.',
    url: '/launch',
    type: 'article',
    publishedTime: PUBLISHED,
    modifiedTime: UPDATED,
    images: [
      { url: '/story/poster.jpg', width: 1920, height: 1080, alt: 'Nic, next to a Styx access request' },
    ],
  },
};

const schema = {
  '@context': 'https://schema.org',
  '@type': 'BlogPosting',
  headline: 'Introducing Styx',
  description:
    'Why I built Styx, a free, open-source app for running AI coding agents across every project, with agents that ask before they touch production.',
  datePublished: PUBLISHED,
  dateModified: UPDATED,
  author: { '@type': 'Person', name: 'Nic', jobTitle: 'Maker of Styx' },
  publisher: { '@type': 'Organization', name: site.name, url: `${site.url}/` },
  image: `${site.url}/story/poster.jpg`,
  mainEntityOfPage: `${site.url}/launch`,
};

/** Product Hunt's post embed, drawn in the site's own style: square, a 1px rule, the site's button. */
const ProductHuntCard = () => (
  <aside className={styles.ph} aria-label="Styx on Product Hunt">
    <div className={styles.phHead}>
      <img src={site.links.productHuntIcon} alt="" width={64} height={64} className={styles.phIcon} />
      <div>
        <p className={styles.phName}>Styx</p>
        <p className={styles.phTag}>An agentic development environment (ADE) for Mac</p>
      </div>
    </div>
    <a className="btn" data-on="true" href={site.links.productHuntPost} target="_blank" rel="noopener">
      Check it out on Product Hunt →
    </a>
  </aside>
);

export default function LaunchPage() {
  return (
    <>
      <a href="#main" className="srOnly">
        Skip to content
      </a>
      <Nav current="launch" />
      <main id="main" className={styles.page}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }}
        />
        <article className={`wrap ${styles.layout}`}>
          <header className={styles.head}>
            <p className={styles.kicker}>
              Launch · <time dateTime={PUBLISHED}>{PUBLISHED_WORDS}</time>
            </p>
            <h1>Introducing Styx</h1>
            <p className={styles.lede}>
              Every project, every agent, every key, one window. Here’s why I built it, and what it does.
            </p>
            <p className={styles.byline}>By Nic, who makes Styx</p>
          </header>

          {/* The product, beside the words about it: the whole window, then the moment the article is about. */}
          <aside className={styles.media} aria-label="Styx, the app">
            <figure className={styles.shot}>
              <img
                src="/launch/workspace.jpg"
                width={1440}
                height={871}
                alt="The Styx window: a project's files and editor with an agent's changes highlighted, a terminal, and the agent's chat on the right"
              />
              <figcaption>One project, its agents and their changes, in one window.</figcaption>
            </figure>
            <figure className={styles.shot}>
              <img
                src="/launch/access-request.jpg"
                width={720}
                height={964}
                loading="lazy"
                alt="An access request: Codex asks to read and write the Supabase production database for an hour, with Grant 1h · Touch ID and Deny"
              />
              <figcaption>An agent asks for production. You decide, for how long, with Touch ID.</figcaption>
            </figure>
          </aside>

          <div className={styles.main}>
            <div className={styles.body}>
              <p>
                <strong>Update, 6 October 2026:</strong> Styx is now open source under the Apache License 2.0,
                with the code on <a href={site.links.github}>GitHub</a>, and runs on Windows and Linux in beta
                as well as the Mac.
              </p>
              <p>
                A few months ago I had four coding agents running across five projects. One of them had been
                waiting on me for twenty minutes, and I had no idea which one. It was sitting in a terminal,
                on a branch, in a window I wasn’t looking at.
              </p>
              <p>That was the moment I stopped looking for a tool for it and started building one.</p>

              <h2>Who I am</h2>
              <p>
                I’m Nic. I build software from South Africa, usually several things at once, and over the last
                year most of that work has moved to AI coding agents: Claude Code, Codex, Gemini and Cursor,
                often all in the same week. They’re very good. Keeping track of them wasn’t.
              </p>

              <h2>What Styx is</h2>
              <p>
                Styx is a free app for the Mac. It puts every project you work on, and every agent working in
                them, in one window. People have started calling this kind of tool an agentic development
                environment, or ADE: not a place to write code, but a place to run and supervise the agents
                that do.
              </p>
              <p>It does three things.</p>
              <h3>1. Everything in one window</h3>
              <p>
                Every project, every agent, and the ones waiting on you first. One keystroke takes you to the
                agent that needs you. Each agent works in its own copy of the repo, on its own branch, so they
                never trip over each other or over you, and when the work is ready you land it on main once
                your checks pass.
              </p>
              <h3>2. It doesn’t replace anything</h3>
              <p>
                Styx sits on top of the editor you already use. It picks up your recent projects, keybindings
                and theme, and opens any file back in your editor with one key. It runs on the Claude,
                ChatGPT, Gemini and Cursor subscriptions you already pay for. I don’t resell model access, and
                there’s nothing new to buy.
              </p>
              <h3>3. Your agents never hold your keys</h3>
              <p>
                The useful agents need to touch real things: a deploy, a database, a server. Until now that
                meant pasting in a token and hoping, or sitting there watching. In Styx your credentials stay
                in your Mac’s Keychain. When an agent wants production, it stops and asks. You approve it for
                a set time, with Touch ID for anything live, and the access ends on its own. Every request and
                every approval goes into a log that nobody can edit: not the agents, and not me.
              </p>

              <h2>How it was built</h2>
              <p>
                Most of Styx was written by the agents it now runs, several at a time, each on its own branch.
                That’s how I found almost every problem it solves: the agent I lost track of, the token I
                shouldn’t have pasted, the one that quietly waited all afternoon.
              </p>
              <p>
                It also taught me that “run an agent” isn’t one thing. Claude Code, Codex, Gemini and Cursor
                each talk to the outside world differently, and getting all four to stop and ask before
                touching something real was most of the work.
              </p>

              <h2>Where it stops</h2>
              <p>
                Styx is a guardrail, not a sandbox. Agents run as you, on your Mac. The commands that go
                through Styx’s tools are gated; an agent that deliberately goes around them isn’t stopped. For
                production I’d still use credentials with the least access you need. I’d rather say that here
                than have you find it.
              </p>
              <p>
                Your code, prompts and agent conversations stay on your Mac. Styx counts a small, fixed set of
                things, like launches and agents started, so I can see what people use, and you can turn that
                off in Settings. The <a href="/privacy">privacy policy</a> has the details.
              </p>

              <h2>What’s next</h2>
              <p>
                Styx is on Mac today and free. Windows is next. After that, it depends on what you tell me,
                which is the real reason I’m launching now.
              </p>
              <p>
                If you run more than one agent, I’d love to know how you keep track of them today, and what
                you’d need to see before you let one near production. There’s a Feedback button in the app
                that comes straight to me, and I read every message. Or write to{' '}
                <a href={`mailto:${site.email}`}>{site.email}</a>.
              </p>
              <p className={styles.sign}>Nic</p>
            </div>

            <div className={styles.cta}>
              <DownloadButton />
              <a href="/story" className={styles.watch}>
                Watch the 1:42 story
              </a>
            </div>

            <ProductHuntCard />
          </div>
        </article>
      </main>
      <Footer />
    </>
  );
}
