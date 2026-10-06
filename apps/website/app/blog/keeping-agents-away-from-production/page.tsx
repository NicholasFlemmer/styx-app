import type { Metadata } from 'next';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { DownloadButton } from '@/components/DownloadButton';
import { site } from '@/lib/site';
import styles from '../../launch/Launch.module.css';
import article from './Article.module.css';

/**
 * Technical article for launch day (7 October 2026): how the grant path works, from the shims to the audit log,
 * the fail-closed target fix (discrepancy row 152), and where it stops. Every claim is checked against the code;
 * the limits quote content/docs/access/security-model.mdx. Built like /launch and shares its CSS module.
 */
const PUBLISHED = '2026-10-07';
const PUBLISHED_WORDS = '7 October 2026';
const UPDATED = '2026-10-07';
const PATH = '/blog/keeping-agents-away-from-production';
const TITLE = 'How Styx keeps coding agents away from production';
const DESCRIPTION =
  'Coding agents run as you, with your logged-in CLIs. How Styx puts a person between them and production: shims, a session-bound broker, a pure policy function, expiring grants, OS authentication and a hash-chained audit log. And where it stops.';

const repo = (path: string) => `${site.links.github}/blob/main/${path}`;
const ADD_TARGET = repo('docs/contributing/adding-a-target.md');

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    title: TITLE,
    description:
      'Shims, a session-bound broker, expiring grants, Touch ID for production, an append-only log.',
    url: PATH,
    type: 'article',
    publishedTime: PUBLISHED,
    modifiedTime: UPDATED,
    images: [
      {
        url: '/launch/access-request.jpg',
        width: 720,
        height: 964,
        alt: 'A Styx access request for a production Supabase database',
      },
    ],
  },
};

const schema = {
  '@context': 'https://schema.org',
  '@type': 'TechArticle',
  headline: TITLE,
  description: DESCRIPTION,
  datePublished: PUBLISHED,
  dateModified: UPDATED,
  author: { '@type': 'Person', name: 'Nic', jobTitle: 'Maker of Styx' },
  publisher: { '@type': 'Organization', name: site.name, url: `${site.url}/` },
  image: `${site.url}/launch/access-request.jpg`,
  mainEntityOfPage: `${site.url}${PATH}`,
};

/* The snippets, verbatim from the code unless marked "simplified". */
const SHIM = `#!/bin/sh
# Styx shim: authorises the command through the grant broker, then execs the real vercel with injected credentials.
exec env ELECTRON_RUN_AS_NODE=1 "$STYX_EXE" "$STYX_CLI" wrap vercel "$@"`;

const POLICY = `// simplified: packages/core/src/policy/engine.ts
evaluate(input: {
  target: { id; provider; env; policy };
  scope: Scope[];                 // read | write | deploy | delete
  session: { id; mayRequestTargets } | null;
  appRules: Policy[];
  projectRules: Policy[];         // .styx/project.json, after you accept them
  persistentGrants: Grant[];
  now: number;                    // time is passed in, never read
}): {
  decision: 'auto' | 'ask' | 'deny';
  requireMfa: boolean;
  maxDuration: Duration;
  idleMs: number | null;
  policyId: PolicyId | null;
}`;

const REQUIRES_MFA = `export const requiresMfa = (env: Env, scopes: readonly Scope[]): boolean =>
  env === 'prod' && scopes.some((s) => WRITE_SCOPES.includes(s));`;

const NEED_MFA = `const needMfa =
  requiresMfa(target.env, scopes) ||
  target.policy === 'ask-mfa' ||
  decision.requireMfa ||
  this.unscopedProd(target, scopes);`;

const TRIGGERS = `CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit_entries is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_entries BEGIN SELECT RAISE(ABORT, 'audit_entries is append-only'); END;`;

const HASH = `export function hashRow(row: Omit<AuditRow, 'hash'>): string {
  const canonical = JSON.stringify(row, Object.keys(row).sort());
  return createHash('sha256').update(row.prevHash).update('\\n').update(canonical).digest('hex');
}`;

const PICK = `const flagged = argv.some((a) => a === '--prod' || a === '--production' || a === 'production')
  ? 'prod'
  : null;
const env = flagged ?? adapter.envOfCommand?.(argv, tool) ?? null;
const prod = candidates.filter((t) => t.env === 'prod');
const rest = candidates.filter((t) => t.env !== 'prod');
const pool =
  env === 'non-prod' ? (rest.length > 0 ? rest : candidates) : prod.length > 0 ? prod : candidates;
return (
  pool.find((t) => this.deps.grants.covering(t, ctx.session.sessionId, scopes) !== null) ??
  pool[0] ??
  null
);`;

const Code = ({ children }: { children: string }) => (
  <pre>
    <code>{children}</code>
  </pre>
);

export default function KeepingAgentsAwayFromProductionPage() {
  return (
    <>
      <a href="#main" className="srOnly">
        Skip to content
      </a>
      <Nav />
      <main id="main" className={styles.page}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }}
        />
        <article className={`wrap ${styles.layout}`}>
          <header className={styles.head}>
            <p className={styles.kicker}>
              Engineering · <time dateTime={PUBLISHED}>{PUBLISHED_WORDS}</time>
            </p>
            <h1>{TITLE}</h1>
            <p className={styles.lede}>
              Agents run as you, with your logged-in CLIs. This is how Styx puts a person between them and
              production, where that stops, and a bug I fixed the day before launch.
            </p>
            <p className={styles.byline}>By Nic, who makes Styx</p>
          </header>

          <aside className={styles.media} aria-label="An access request in Styx">
            <figure className={`${styles.shot} ${article.portrait}`}>
              <img
                src="/launch/access-request.jpg"
                width={720}
                height={964}
                alt="An access request: Codex asks to read and write the Supabase production database for an hour, with Grant 1h · Touch ID and Deny"
              />
              <figcaption>
                The request an agent’s command turns into. Nothing runs until you answer.
              </figcaption>
            </figure>
          </aside>

          <div className={styles.main}>
            <div className={`${styles.body} ${article.body}`}>
              <p>
                Every coding agent I use runs as me. Claude Code, Codex, Gemini CLI and Cursor’s agent start
                with my <code>PATH</code>, my files and my logged-in CLIs. If I’ve run{' '}
                <code>vercel login</code>, <code>gcloud auth login</code> or <code>supabase login</code> on
                this machine, the agent has too. Nothing in that setup knows the difference between{' '}
                <code>vercel deploy</code> and <code>vercel deploy --prod</code>, or between a{' '}
                <code>supabase db push</code> to a scratch project and one to the database people are using.
              </p>
              <p>
                I run several at once, across several projects, and I don’t read every command. One wrong{' '}
                <code>--prod</code> and it’s done before I look.
              </p>
              <p>
                Styx is the app I built to run those agents. This is how the part between an agent and your
                deploy targets works, and where it stops. The code is Apache-2.0; I’ve linked the files.
              </p>

              <h2>The shape</h2>
              <p>
                A command like <code>supabase db push</code> takes this path:
              </p>
              <ol>
                <li>
                  A shim named <code>supabase</code>, first on the agent’s <code>PATH</code>, catches it.
                </li>
                <li>The shim asks a local broker. Its connection is bound to one agent session.</li>
                <li>A pure policy function decides: approve, ask or deny.</li>
                <li>On ask, the agent waits and you get a request, in its chat and as a notification.</li>
                <li>
                  You grant it for a set time. Production writes, deploys and deletes need Touch ID, Windows
                  Hello or your system password first.
                </li>
                <li>
                  The real command runs with that grant’s credentials in its environment, and nothing else.
                </li>
                <li>Every step is written to an append-only, hash-chained audit log.</li>
              </ol>

              <h2>Shims on PATH</h2>
              <p>
                When Styx starts an agent, a directory of small scripts goes first on its <code>PATH</code>:{' '}
                <code>vercel</code>, <code>gh</code>, <code>aws</code>, <code>gcloud</code>,{' '}
                <code>supabase</code> and <code>ssh</code>. This is the <code>vercel</code> one, from{' '}
                <a href={repo('apps/desktop/src/main/services/shim-service.ts')}>shim-service.ts</a>:
              </p>
              <Code>{SHIM}</Code>
              <p>
                <code>styx wrap</code> connects to the broker, calls <code>exec_authorize</code> with the
                tool, its arguments and the working directory, and waits up to ten minutes for an answer. On
                yes, it starts the real binary with the grant’s environment added. On no, it prints{' '}
                <code>styx: access to vercel was not granted</code> and exits 77. When it finishes, the shim
                reports the exit code for the log.
              </p>
              <p>
                The broker reads the command to decide what it needs. <code>ls</code> or <code>view</code> is
                a read, <code>deploy</code> a deploy, <code>delete</code> or <code>drop</code> a delete.
                Anything it doesn’t recognise counts as a write, so a misread command is treated as more
                dangerous, never less. Agents can also ask up front through an MCP tool,{' '}
                <code>request_access</code>.
              </p>

              <h2>A broker bound to one session</h2>
              <p>
                The <a href={repo('apps/desktop/src/main/broker/host.ts')}>broker</a> runs in Electron’s main
                process on a per-user Unix socket, in a directory that must be yours with mode 0700 (a named
                pipe on Windows). Each agent session gets its own token in its environment. Styx stores only
                its SHA-256 and compares in constant time. After the handshake a connection belongs to that
                one session: it can see its own grants, or <code>always</code> grants on its own project’s
                targets, and nothing else. New requests are limited to five a minute per session.
              </p>

              <h2>Policy is a pure function</h2>
              <p>
                The decision is made in <a href={repo('packages/core/src/policy/engine.ts')}>packages/core</a>
                , which has no Electron, no I/O and no clock of its own. CI enforces 100% test coverage on it.
                Its shape:
              </p>
              <Code>{POLICY}</Code>
              <p>
                It stops at the first step that decides: a task not allowed to request targets is denied; a
                covering <code>always</code> grant answers; a target set to Always allow approves; then your
                rules, top to bottom; otherwise it asks. Rules from a repo’s <code>.styx/project.json</code>{' '}
                can only make Styx ask more until you accept them, since anyone with commit access can edit
                that file.
              </p>
              <p>One predicate sits under all of it:</p>
              <Code>{REQUIRES_MFA}</Code>
              <p>
                An auto-approve rule that matches a production write becomes an ask with verification. The
                grant <a href={repo('packages/core/src/machines/grant.ts')}>state machine</a> checks the same
                predicate again on <code>issue</code> and refuses the transition unless verification happened.
                The only exception is an <code>always</code> grant you approved earlier, with verification,
                that covers the request.
              </p>

              <h2>Asking you</h2>
              <p>
                On ask, the request appears in the agent’s chat, on its task, in the Access screen and as a
                system notification; answering in one place answers it everywhere. You see the agent, the
                target, its reason and the scopes. You can untick scopes to grant less, but not add any. Until
                you answer, the shim is blocked, so the agent is just waiting on a command.
              </p>

              <h2>Grants are scoped and expire</h2>
              <p>
                A grant is one target, a set of scopes, and a duration: once, 1h (the default), session or
                always. Once and 1h end an hour after you grant them at the latest, and a built-in rule ends
                any grant except <code>always</code> after an hour without use. Session grants end with the
                session, and you can revoke one early. The lifecycle is an exhaustive transition table, tested
                for every pair of state and event, invalid ones included.
              </p>

              <h2>Production needs the OS to say it’s you</h2>
              <p>
                On a production target, a grant that includes write, deploy or delete is only issued after the
                operating system confirms it’s you: Touch ID on a Mac, Windows Hello on Windows, polkit on
                Linux. A Mac without Touch ID (no sensor, or the lid closed) shows the macOS password prompt
                instead. If the machine can’t verify at all, Styx refuses the grant rather than skip the
                check.
              </p>
              <p>
                What matters is where that’s decided. The window you click in is sandboxed and has no say.{' '}
                <a href={repo('apps/desktop/src/main/services/grant-service.ts')}>GrantService.approve</a>, in
                the main process, recomputes it from the database:
              </p>
              <Code>{NEED_MFA}</Code>
              <p>
                The last term is for providers that can’t narrow a credential to a scope. For Vercel,
                Supabase, GitHub and SSH, any grant on a production target needs verification, reads included.
                While writing the docs I also found that <code>STYX_MFA=auto</code>, a switch that fakes the
                OS prompt for our end-to-end tests, was honoured by release builds. An agent runs as you and
                could relaunch Styx with it set. Packaged builds now ignore it.
              </p>

              <h2>What the command gets</h2>
              <p>
                Stored credentials never go into an agent’s starting environment. Styx also drops tokens such
                as <code>GH_TOKEN</code>, <code>VERCEL_TOKEN</code> and <code>AWS_SECRET_ACCESS_KEY</code>{' '}
                from what agents inherit, so one exported in your shell profile doesn’t reach them. The
                granted command gets credentials for the life of the grant. On AWS that’s temporary STS
                credentials with a session policy limited to the granted scopes (unless you connected a CLI
                profile with no role to assume). On GCP it’s an access token that lasts at most an hour.
                Vercel, Supabase and GitHub get the token you stored, because they can’t issue a narrower one.
              </p>
              <p>
                SSH never gets a key file. Styx runs its own SSH agent in-process, holding the key in memory
                for the grant’s lifetime, and points the command’s <code>SSH_AUTH_SOCK</code> at it. The
                socket closes when the grant ends.
              </p>

              <h2>Secrets stay in the keychain</h2>
              <p>
                The secrets Styx holds live in the OS credential store (Keychain, Credential Manager, Secret
                Service). The database, logs, messages between processes, the interface and{' '}
                <code>.styx/project.json</code> only ever hold a reference of the form{' '}
                <code>styx:v1:&lt;provider&gt;:&lt;targetId&gt;:&lt;kind&gt;</code>. By default it stores
                none: it reuses your provider CLI’s own login and asks it for a current token per grant.
              </p>

              <h2>An append-only, hash-chained log</h2>
              <p>
                Every request, grant, denial, use, revoke and expiry is a row in <code>audit_entries</code>,
                with the actor, the session, the worktree and what triggered it; for a use, that’s the command
                line, with secrets scrubbed before it’s written. The table can only grow. From the first
                migration:
              </p>
              <Code>{TRIGGERS}</Code>
              <p>
                A revoke inserts a new row; nothing edits an old one. Each row also carries the previous row’s
                hash and its own, computed in the same transaction as the insert:
              </p>
              <Code>{HASH}</Code>
              <p>
                Editing a field or removing a row breaks the chain from that point on; the{' '}
                <a href="/docs/access/audit-log">audit log docs</a> have a short script to check it. The chain
                shows entries weren’t edited one at a time. Someone who can already write your files could
                rewrite the whole log and recompute every hash, so keep a copy of the latest hash elsewhere if
                that matters to you.
              </p>

              <h2>Failing closed: a bug I found writing the docs</h2>
              <p>
                A project can have two targets for one provider: a Supabase staging project and a Supabase
                production project, say. When a shimmed command came in, the broker had to pick which one it
                meant. The rule was: a target with a live grant covering the command won; otherwise{' '}
                <code>--prod</code> meant production; otherwise the first non-production target.
              </p>
              <p>
                I found the problem while writing the docs, the day before launch, trying to say which target{' '}
                <code>supabase db push</code> is judged against. The command names no environment; it pushes
                to whichever project the directory is linked to, which may be production. Under the old rule
                it was judged against staging, so staging’s looser policy, or an open staging grant, could
                carry a command that changes the production database.
              </p>
              <p>
                Now the environment is decided first, and not knowing counts as production.{' '}
                <code>BrokerHost.pickTarget</code>:
              </p>
              <Code>{PICK}</Code>
              <p>
                Where the CLI makes it knowable, the adapter says. Vercel does: only a deploy without{' '}
                <code>--prod</code> or <code>--target production</code>, an <code>env</code> command that
                names preview or development, and a read count as preview. Everything else, from{' '}
                <code>promote</code> to <code>rm</code>, is production. For every other CLI, a command that
                names no environment is judged against the production target whenever there is one, and only a
                grant on that target can cover it. A staging grant can’t carry it. The cost is the occasional
                extra prompt for a command that was meant for staging.
              </p>

              <h2>Where it stops</h2>
              <p>
                Styx is a guardrail, not a sandbox. In the words of the{' '}
                <a href="/docs/access/security-model">security model</a> page:
              </p>
              <blockquote>
                <p>
                  Agents run as you. An agent can read and write anything your user account can, run any
                  program, and reach the network. Styx doesn’t contain it.
                </p>
              </blockquote>
              <p>
                And an agent that goes around Styx isn’t stopped. The shims catch <code>vercel</code>,{' '}
                <code>gh</code>, <code>aws</code>, <code>gcloud</code>, <code>supabase</code> and{' '}
                <code>ssh</code> when they’re run by name. They don’t catch:
              </p>
              <ul>
                <li>
                  the real CLI called by its full path. If you connected that provider through its CLI, the
                  CLI is still signed in as you and works without a grant. Styx tells agents not to do this,
                  and when Claude Code or Codex does it anyway, Styx posts a warning in the chat saying no
                  grant was asked and nothing was audited. It warns; it doesn’t block;
                </li>
                <li>
                  other tools from the same providers: <code>scp</code>, <code>rsync</code>, <code>sftp</code>
                  , <code>gsutil</code>, <code>bq</code>, <code>sam</code> and <code>cdk</code> aren’t wrapped
                  today;
                </li>
                <li>
                  <code>git push</code> with your usual git credentials, or a provider’s SDK or API called
                  with a token the agent found on disk.
                </li>
              </ul>
              <p>
                For Vercel, Supabase and GitHub, a granted command receives your whole stored token. A command
                could copy it during the grant, and revoking stops Styx delivering it but doesn’t cancel it at
                the provider. For production, use dedicated tokens with the least access that works. Styx
                makes the safe path the easy one and keeps a record of it. It won’t stop an agent that’s
                trying to escape; if you need that, run agents in a container or VM as well.
              </p>

              <h2>What’s next</h2>
              <p>On the list:</p>
              <ul>
                <li>
                  shims for the other tools the provider adapters already classify (<code>scp</code>,{' '}
                  <code>rsync</code>, <code>sftp</code>, <code>gsutil</code>, <code>bq</code>,{' '}
                  <code>sam</code>, <code>cdk</code>);
                </li>
                <li>
                  verifying the hash chain and exporting the log from inside the app, instead of with{' '}
                  <code>sqlite3</code>;
                </li>
                <li>more targets: Azure and Netlify aren’t supported yet.</li>
              </ul>
              <p>
                To check any of this, start with the{' '}
                <a href={repo('packages/core/src/policy/engine.ts')}>policy engine</a> and the{' '}
                <a href={`${site.links.github}/tree/main/apps/desktop/src/main/providers`}>
                  provider adapters
                </a>
                . If your provider is missing, <a href={ADD_TARGET}>adding a target</a> walks through one
                adapter end to end: the name, how it connects, how it reads a command’s scope, and the shim.
                And if you find a way past any of this, please report it privately as{' '}
                <a href={repo('SECURITY.md')}>SECURITY.md</a> describes, not in a public issue.
              </p>
              <p>
                Questions and arguments are welcome on <a href={site.links.discussions}>GitHub Discussions</a>{' '}
                or at <a href={`mailto:${site.email}`}>{site.email}</a>.
              </p>
              <p className={styles.sign}>Nic</p>
            </div>

            <div className={styles.cta}>
              <DownloadButton />
              <a href="/docs/access/how-access-works" className={styles.watch}>
                Read how access works
              </a>
            </div>
          </div>
        </article>
      </main>
      <Footer />
    </>
  );
}
