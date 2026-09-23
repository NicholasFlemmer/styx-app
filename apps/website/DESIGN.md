# Styx website: research and design plan

The marketing site for Styx. Next.js 16 (app router, static export), plain CSS Modules, the app's own
tokens from `@styx/tokens`. Lives at `apps/website`, runs on port 3100.

## 1. What the best developer-tool sites do (research, September 2026)

Reviewed: Linear, Zed, Cursor, Raycast, Warp, Ghostty, Cerebrium (Awwwards developer award), and the two
closest analogues, Conductor ("Run parallel coding agents on your Mac") and Vibe Kanban. Plus the
Awwwards developer category and 2026 landing-page surveys.

1. **One precise positioning line** that names the outcome and the person, then one primary action.
   Zed: "Your last next editor." Conductor: "Run parallel coding agents on your Mac." Cursor: "Cursor is
   your coding agent for building ambitious software." Nobody leads with a category word.
2. **The product is the hero image.** Linear, Cursor and Zed put the real interface under the headline.
   Cerebrium won its Awwwards developer award with animated _comparisons_ of real numbers, not
   illustration. Interactive demos on the page are the 2026 standout pattern.
3. **Dark by default.** Roughly 70% of the best app landing pages surveyed in 2026 open dark. Styx's
   tokens are dark-first anyway.
4. **Three pillars right after the hero.** Zed: Fast / Agentic / Collaborative. Ghostty: fast /
   feature-rich / native. Raycast: Fast / Ergonomic / Personal / Reliable.
5. **Specific facts beat adjectives.** Ghostty "2ms", Raycast "99.8% crash-free", Vibe Kanban
   "100,000+ PRs". Styx has real ones: 1h default grant, Touch ID for prod, append-only hash-chained
   audit, one worktree per agent, six targets, five agents.
6. **Honest, measured tone.** Ghostty's writing is the reference: ambition without superlatives.
   Sentence case. Short sections. Linear's copy runs 15–50 words per block.
7. **One download CTA, platform-detected**, with a quiet secondary (source, docs, or "how it works").
   Version number and a changelog signal an alive product (Conductor shows 0.85.0 in the hero).
8. **Performance and responsiveness are judged.** Awwwards scores both. Static export, self-hosted
   fonts, no third-party scripts, reduced motion respected.
9. **The gap in the market.** Conductor and Vibe Kanban both sell "parallel agents in isolated
   worktrees, then review and merge". Neither gates what the agents can _reach_. The access gate is
   Styx's memorable thing and the site leads with it.

## 2. Design plan

**Brief.** Desktop app for developers who already run Claude Code, Codex, Gemini CLI or Cursor, often
several at once, and have felt the fear of an agent holding `vercel --prod` or an AWS key. The site's
job: explain in ten seconds, prove it with the product itself, get a download.

**Color.** The app's tokens verbatim, both themes, following the OS and switchable with ⌘⇧T like the
app. Dark: bg `#0d0e0c`, s1 `#121411`, s2 `#1c1e1a`, line `#2d302a`, text `#e9ebe3`, muted `#858a81`,
accent `#d6ff3d`. The accent is used the way the app uses it: as a _state_. Only things that ask for you
are lime: the grant button, the needs-you dot, the counter. No lime headlines, no gradients, no glow.

**Type.** Archivo for everything including display (600, tracking −0.03em, the app's numeral treatment
scaled up). JetBrains Mono for everything that comes from the machine: commands, audit rows, paths, the
UI mocks. Body 15px/1.55 (the app's 13px is for a 1280px window, not a reading page). Scale 12 / 13 /
15 / 18 / 24 / 32 / 48 / display clamp(40–76). Uppercase tracked labels only inside product mocks and
on buttons, where they are the product's vocabulary, never as eyebrows above marketing headlines.

**Layout: the ruled sheet.** One column, left-aligned, max 1280 (the app's window width) with 24px
gutters. Every section is a row bounded by full-bleed 1px rules, like the app's tables; columns inside
a row are separated by vertical rules. Rules encode structure (this is a different row, a different
column), never decoration. Radius 0, no shadows.

```
STYX                 How it works  Access  Agents  Security   [Download]
──────────────────────────────────────────────────────────────────────────
Every agent, every project,       ┌──────────────────────────────────┐
one window. Nothing reaches       │ files │ editor        │ chat     │
production without you.           │       │               │  ask →   │
                                  │       │ terminal      │  sheet   │
[Download for macOS] How a grant works    └──────────────────────────────────┘
Runs on your machine. No account.  ▪ ▪ ▪ ▪ ▪  step controls
──────────────────┬──────────────────────┬────────────────────────────────
Switch            │ Supervise            │ Gate
──────────────────┴──────────────────────┴────────────────────────────────
How a grant works   1 command  2 pause  3 scope  4 token  5 record
──────────────────────────────────────────────────────────────────────────
Agents you already run            │ Targets they reach for
──────────────────────────────────────────────────────────────────────────
One agent, one worktree            [lane table]
──────────────────────────────────────────────────────────────────────────
What Styx will not do              six plain statements
──────────────────────────────────────────────────────────────────────────
Keyboard                           the real shortcut map
──────────────────────────────────────────────────────────────────────────
Download            macOS · Windows · 0.1.0
──────────────────────────────────────────────────────────────────────────
footer
```

**The one bold thing.** The hero's workspace mock plays the grant flow with the app's own motion:
Codex runs `supabase db push`, the shim pauses the session, the ask lands in chat and the titlebar
ticks to 01 needs you, the sheet slides in (160ms), Touch ID, the grant line appears, the terminal
continues, a toast records the audit row. Loops; pauses on hover or focus; five step buttons make it
scrubbable and keyboard-reachable. With reduced motion it does not autoplay and steps are fades.
Nothing else on the page moves except hover and focus, which are instant, like the app.

**Principles.**

1. The product is the imagery. UI mocks are DOM built from the tokens: crisp at any DPI, themed, no rasters.
2. Lime means "asking for you".
3. Rules encode structure.
4. Facts over adjectives; the app's own words (Needs you, Grant 1h, Review request).
5. Sentence case, active voice, no closing flourishes.

## 3. Review against the defaults

- Near-black plus acid green is a known generated-page look. Here it is the product's identity (the
  handoff is pixel-final), so the brief wins. Mitigation: accent as state only; most of the page is
  text on bg with s1 surfaces.
- Zero radius plus hairlines can read as "broadsheet". Mitigation: the rules are table rules holding
  data and columns of product, not newspaper text columns; type is a grotesque, not a serif.
- No tracked-caps eyebrows on marketing copy, no middle-dot meta strings outside mocks, no arrows
  appended to links, no per-section fade-ups, no numbered markers except the grant timeline, which is
  a real sequence.

## 4. Copy direction (revised 2026-09-11)

The first draft explained the machinery (worktrees, shims, PATH, hash chains) and was rejected as too technical.
The pitch is now the convergence and the crossing, in everyday words:

- **The chant.** "Every project. Every agent. Every key. One window." Multi-project, multi-agent, multi-login,
  all in one place. That is the headline and the three pillars.
- **The river.** Styx is the boundary nothing crosses without permission. Agents build freely on your side; to
  deploy or touch live data they must cross, and the crossing asks you. Used once in the hero, once as the title
  of the approval walkthrough ("What happens at the crossing"), and once for the security list: an oath sworn on
  the Styx could not be broken, even by a god, and neither can the record.
- **Mechanism as proof, not message.** Technical guarantees live in the "What Styx will never do" list, one short
  sentence each. Inside product mocks the app's own UI strings stay verbatim.
- **Your editor comes along.** Onboarding detects VS Code, Cursor, JetBrains IDEs and Neovim, imports recents,
  keybindings and theme, and wires "Open in". The site says so in the compatibility section.

## 5. Second pass: the site behaves like the app (2026-09-11)

Built after review. No keyboard shortcuts are taken over on the site beyond the theme toggle.

- **Hero demo autoplays** whenever it is on screen; clicking a step jumps there and keeps going; Pause is the only
  stop. A Mac / Windows toggle swaps the mock's window chrome and the biometric named in the sheet.
- **Counters strip** under the hero: the Home screen's four 56px numerals, following the demo through a shared
  `DemoProvider` (Needs you ticks to 01 while the request waits; Grants active ticks to 03 once granted).
- **Scroll-driven crossing**: the five steps scroll past on the left while the live workspace mock stays pinned on
  the right and follows whichever step is mid-viewport (`CrossingScroller`). Step 3 shows the sheet, then Touch ID.
  Under the mock, the **river strip**: one 1px line; the request waits on the near bank (lime while it needs you),
  crosses when granted, and the audit line lands on the far bank. On phones the mock pins under the nav at small
  scale and the river is hidden.
- **Screens strip**: eight screens (Home, Workspace, Agents, Repo, Approvals, Diff review, Settings, Onboarding) as
  DOM mocks at the app's real 1280×800, scaled by `MockFrame`, in a scroll-snapping row.
- **Rhythm and load**: alternate sections on the panel colour (`data-tone="panel"`); one load sequence (the
  titlebar rule draws across, then the workspace fades in), nothing else moves on load.
- **Mac first**: the download button always offers macOS; Windows is a large "Coming soon" card and a one-line note
  for Windows visitors.

Mock architecture: `components/demo/MockFrame` (measure and scale), `WorkspaceMock` (pure, driven by step and
chrome), `DemoContext` (shared hero state); `components/screens/*` for the strip.

## 6. Copy sources

Product strings come from `packages/core/src/copy.ts` and spec §10 so the site and the app say the
same things. Facts (1h idle expiry, biometric for prod, append-only audit, one worktree per agent,
keychain-only secrets, renderer never touches disk or network) come from `CLAUDE.md` and `docs/adr/`.
Links that do not exist yet (download URLs, releases, source) live in `lib/site.ts` and default to
page anchors.

## 7. Catching up with the app (2026-09-23)

The site was written on 2026-09-11 and shipped 2026-09-18; the app kept going. By 2026-09-23 several claims had
become false rather than merely incomplete, and were corrected first:

- "Nothing to sign up for" / "There is no account and no Styx server" — there is now an account (GitHub or
  Google), free for one project and asked for on the second, and a Styx server that knows the account and counts
  five feature events. The promise that still holds is the one kept: your work never leaves your computer.
- Codex and Gemini CLI "run in their own terminal" — all four agents now chat inside Styx with approvals.
- "a / r keep or drop a change", "Accept all" — nothing is accepted any more; an agent's edit is applied, and
  review reverts it or marks it reviewed. The keyboard row, the workspace mock and the diff mock now use the app's
  own verbs.
- The editor list gained Windsurf and Zed.
- "Clashes stop the agent, you sort it out" — a clashing merge now goes back to the agent that made it.

Then one section was added, **Shipping** (`components/Ship.tsx`), between "Your code" and the screens strip: see it
running, keep talking while it works, undo a turn, publish in one step, deploy to live, skills for every agent, and
a one-line "also" for usage, tech-debt reviews and the agent dock. Panel tones below it were flipped so the page
still alternates. Snake is deliberately not on the site.
