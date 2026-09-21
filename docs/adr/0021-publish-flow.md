# ADR-0021 Publish: commit, push and pull request in one step

Status: accepted · 2026-09-17 (owner request after the t3code comparison)

The handoff's Repo screen shows lanes with a PR column and one verb per lane (Open · Diff · Resolve · Archive); the
spec has no way to get a worktree's work onto GitHub from inside Styx. The owner asked for what t3code does: one
action that commits what changed, pushes the branch and opens the pull request, with the commit message and the
PR title and body drafted by the agent from the diff and editable before anything is sent.

## Decision

One main-process service, `PublishService` (`apps/desktop/src/main/services/publish-service.ts`), behind two
contract commands: `worktree.generateMessage { worktreeId, kind: 'commit' | 'pr' } → { title, body }` and
`worktree.publish { worktreeId, through: 'commit' | 'push' | 'pr', message, draft } → { commit, pushed, pr }`.

- **Steps are reused, never repeated.** `publish` runs commit → push → PR up to `through`: a clean tree skips
  the commit, a branch whose upstream already has everything skips the push, an open PR for the branch
  (`gh pr view <branch> --json number,url,state,isDraft`, state `OPEN`) is returned rather than duplicated. A
  merged or closed PR counts as none. What cannot work is refused before anything is committed: no remote
  (`copy.publish.noRemote`), or a PR asked for main / the base branch.
- **The modal drives the steps one call at a time.** `PublishModal` calls `worktree.publish` with
  `through: 'commit'`, then `'push'`, then `'pr'`; because every call reuses what the previous one did, this gives
  a progress line per step from the same command, a failure stops at the step that failed, and a retry after a
  fix reports only the step that was still open. The cost is one extra `git status` per step and a Home feed row
  per step (`you · acme-shop · published fix/checkout (PR #7)`).
- **`gh` runs under a grant, like an agent's shim call.** When the project has a connected GitHub target, the
  service asks `GrantService.request({ sessionId: null, scope: ['write'], reason: 'Publish <branch> …' })` —
  the same request → policy → issue → use → audit path `DeployService` takes — and hands the minted token to
  `gh` in its environment (`GH_TOKEN`; never on argv, never logged). The push uses the same grant: the token
  travels as a one-shot `http.extraheader` (`GitService.push`) for an https github.com remote, and an ssh remote
  goes through the user's agent as it always did. Every `gh` call and the push are recorded as grant uses with
  their exit codes; the created PR is an `opened-pr` audit row (`detail.via: 'grant'`). A target whose policy
  asks cannot be answered from a button with no session, so it fails with `copy.publish.needsApproval` rather
  than silently bypassing the policy. A grant minted for the step is revoked (`reason: 'policy'`) when the step
  ends, success or not, so nothing outlives the button press; only an `always` grant the user already holds is
  reused and left alone. App-owned grants (`sessionId: null`) are never handed to a session: `covering()` shares
  only `always` grants across owners and `credentialFor` refuses a session asking for a per-step app grant.
  The push header goes only to an https `github.com` push URL (`remoteHost`, real hostname, not a substring —
  `github.com.evil.io` is `other`); any other remote is pushed without the token through the user's own setup,
  with `GIT_TERMINAL_PROMPT=0` and the credential helper disabled on the token path so git never prompts or
  writes the token to a helper.
- **Secret files stay out of the commit and out of the draft.** Staging lists changed paths and drops
  `isSecretFile` matches (`.env*` bar the examples, `*.pem`, `*.key`, key stores, `id_rsa*`); the patch handed to
  the drafting agent and to the message fallback is filtered the same way and passed through `redactPatch`, which
  masks `KEY=value` lines for secret-looking keys and credential URLs (`postgres://u:p@h`) in what remains.
- **No GitHub target → the user's own `gh` login.** `gh` still runs (with provider tokens stripped from the
  environment, so the CLI's own login answers), no grant is requested, the audit row says
  `via: 'own-gh-login'` and the feed row ends in `· your own gh login`. `gh` is looked up on the process PATH
  first, then the login shell's, so the e2e's fake `gh` shadows a real install.
- **The draft costs one prompt of the user's own subscription.** `generateMessage` runs the project's default
  agent headless with the diff on stdin — `claude -p --output-format json --tools ""` (no tools, so it only
  writes), `codex exec --json --ephemeral --sandbox read-only --skip-git-repo-check`, `gemini -p --output-format
json` — capped at 60 KB of numstat + patch and 60 s. That is the trade t3code makes and the owner asked for:
  the draft is editable before it is sent, and a missing binary, a timeout, a non-zero exit or an unreadable
  reply fall back to a message drafted from the file list (`Update checkout.ts and validate.ts` /
  `Update 5 files in src`, files in the body) instead of blocking. Cursor's agent and the shell have no one-shot
  headless mode here and always get the fallback. The reply is parsed as first non-empty line = title (≤ 72
  chars; `Subject:`/`Title:` prefixes, quotes and a single code fence dropped), the rest = body.
- **Reachable from three places.** The Repo lane's action cell gains a second verb — `Open PR` for a lane without
  an open PR, `Commit & push` for one that has it or for main; none for merged, conflicted or branchless lanes —
  and the PR cell becomes a link (`link.open`) once the PR's page is known. The workspace mode strip gets a
  secondary `Publish` button before Deploy for the worktree the editor shows. The palette's Actions group gets
  `Publish <project> · <branch>` for the branch the project is on (`projectWorktreeOf`).

## Consequences

- `Container.publish` is a real `PublishService` (the optional slot from the foundation commit is gone); tests
  swap in a service with a fake `exec` (the handlers read `app.publish` per call).
- e2e gets a fake `gh` and a fake `claude` in `e2e/fixtures/bin`: the fake `claude` reports version 99.0.0 so
  detection prefers it over a real install and no test ever spends the owner's usage; the publish spec re-detects
  CLIs first, like the Codex spec does.
- The publish commit is the user's: `GitService.commit(…, { asUser: true })` uses the repo's / global git
  identity and only falls back to `Styx <styx@localhost>` when git has none at all. Scaffolds and checkpoints
  keep the Styx identity.
- The Repo lane table widens its action column (`1.2fr 1fr 1.4fr .9fr 1fr` instead of the prototype's
  `1.2fr 1fr 1.6fr 1fr .7fr`) so two verbs (`Commit & push · Open`) sit on one line down to the 1100px window
  minimum; Changes and PR give up the width.
- Copy additions (`copy.publish.*`, `copy.palette.actions.publish*`) are not in spec §10; logged as
  discrepancy #90.

## Addendum (2026-09-21) — connecting the remote, and the push header

- **A project with no remote can get one from Styx.** Publish's only answer used to be "add one under Repo", and
  Repo had no way. `project.connectRemote` (Repo header `Connect to GitHub`; the Publish modal's notice, which
  reopens Publish once done) creates a private repo through the connected GitHub target — created, `origin`, the
  current branch pushed, audited `connected` — or takes an existing repo's URL (`owner/name` shorthand means
  github.com) as `origin` with no GitHub connection needed. With a remote the same button reads `Reconnect` and
  replaces `origin` outright (a wrong or dead remote is a new remote, not an edit), after saying which one is
  there. The remote is never replaced without that explicit ask.
- **The token push uses basic auth.** The grant's token travelled as `Authorization: bearer`, which GitHub's REST
  API accepts and its git endpoint does not: the push got 401, git asked for a username, the prompt was disabled
  by design, and the person read "unable to read askpass response from /usr/bin/false". The header is now
  `basic` with `x-access-token:<token>` (the form GitHub documents and actions/checkout uses), it takes a PAT, a
  fine-grained PAT, an installation token and `gh`'s OAuth token alike, and a refused token is reported as one.
