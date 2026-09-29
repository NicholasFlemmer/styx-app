import type { Metadata } from 'next';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { DownloadButton } from '@/components/DownloadButton';
import { site } from '@/lib/site';
import styles from './Story.module.css';

/**
 * Why I built Styx: the founder video, hosted by us (no YouTube player, no third-party tracking), with its
 * captions and the full transcript on the page, for people who read rather than watch and for search.
 */
const VIDEO = 'https://storage.googleapis.com/styx-desktop-releases/site/styx-story-2026-09-29.mp4';
const POSTER = '/story/poster.jpg';
const PUBLISHED = '2026-09-29';

export const metadata: Metadata = {
  title: { absolute: 'Why I built Styx: the founder story in under two minutes' },
  description:
    'Four coding agents, five projects, one waiting on me for twenty minutes. Nic on why he built Styx, and what it does about it.',
  alternates: { canonical: '/story' },
  openGraph: {
    title: 'Why I built Styx',
    description: 'Four coding agents, five projects, and no idea which one was waiting on me.',
    url: '/story',
    type: 'video.other',
    images: [{ url: POSTER, width: 1920, height: 1080, alt: 'Nic, next to a Styx access request' }],
    videos: [{ url: VIDEO, type: 'video/mp4', width: 1920, height: 1080 }],
  },
};

const TRANSCRIPT = [
  'Right now, I’ve got four coding agents running across five projects. One of them has been waiting on me for twenty minutes and I have no idea which one. I’m Nic, and that’s why I built Styx.',
  'If you run Claude Code, Codex, Gemini or Cursor on more than one project, you know the feeling. Every agent lives in its own terminal, on its own branch, in some window you’re not looking at. And every tool that promises to fix it wants you to move in: a new editor, a new workspace, one project at a time.',
  'Then there’s access. The useful agents need to touch real things, like your deploys, your database, your servers. So you either paste in a token and hope, or you sit there and watch it. I’ve done both, and I didn’t love either.',
  'Styx fixes that in three ways. First, everything’s in one window. Every project, every agent. You can see what’s waiting on you, and one keystroke takes you straight there.',
  'Second, it doesn’t replace anything. It sits on top of the editor you already use and runs on the Claude and Codex subscriptions you already pay for. It picks up your recent folders, keybindings and theme, and one key opens anything back in your editor.',
  'Third, it holds your keys so your agents don’t have to. When an agent wants production, it stops and asks, and you approve it for a set window of time. Every request and every approval goes into a log nobody can edit: not the agents, and not me.',
  'Every project, every agent, every key, in one window. It’s free right now, and it’s on Mac today.',
];

const schema = {
  '@context': 'https://schema.org',
  '@type': 'VideoObject',
  name: 'Why I built Styx',
  description:
    'Nic, who makes Styx, on running four coding agents across five projects, and how Styx puts them in one window and keeps them away from production keys.',
  thumbnailUrl: [`${site.url}${POSTER}`],
  uploadDate: PUBLISHED,
  duration: 'PT1M42S',
  contentUrl: VIDEO,
  embedUrl: `${site.url}/story`,
  transcript: TRANSCRIPT.join(' '),
  inLanguage: 'en',
  publisher: { '@type': 'Organization', name: site.name, url: `${site.url}/` },
};

export default function StoryPage() {
  return (
    <>
      <a href="#main" className="srOnly">
        Skip to content
      </a>
      <Nav current="story" />
      <main id="main" className={styles.page}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }}
        />
        <div className="wrap">
          <header className={styles.head}>
            <p className={styles.kicker}>The story · 1:42</p>
            <h1>Why I built Styx</h1>
            <p className={styles.lede}>
              Four coding agents, five projects, and one of them had been waiting on me for twenty minutes.
            </p>
          </header>
          <figure className={styles.player}>
            <video controls playsInline preload="metadata" poster={POSTER} width={1920} height={1080}>
              <source src={VIDEO} type="video/mp4" />
              <track kind="captions" src="/story/captions.en.vtt" srcLang="en" label="English" />
              Your browser can’t play this video. The transcript is below.
            </video>
          </figure>
          <div className={styles.cta}>
            <DownloadButton />
            <span className={styles.note}>Free · Mac · Windows soon</span>
          </div>
          <section className={styles.transcript} aria-labelledby="transcript">
            <h2 id="transcript">Transcript</h2>
            {TRANSCRIPT.map((p) => (
              <p key={p.slice(0, 24)}>{p}</p>
            ))}
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
