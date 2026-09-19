# ADR-0024 Agent CLIs are found the way the terminal finds them, and installed from Styx with the vendor's own installer

Status: accepted · 2026-09-19 (owner request)

Bring-your-own-subscription depends on Styx finding the CLI the user already signed into. It did not: `DetectService`
scanned the Electron process's PATH, which for a Dock-launched macOS app is `/usr/bin:/bin:/usr/sbin:/sbin`. A CLI
installed the way every vendor recommends — `~/.local/bin` (Claude, Cursor), Homebrew, an npm global under nvm — was
invisible, while the VS Code / Cursor extension bundles and Claude.app were found because they are scanned by absolute
path. Hence "it only works when the IDE installed it". The pty and the cloud-CLI runner already resolved the login
shell's PATH; detection was the one caller that never did.

## Decision

1. **Detection sees what the terminal sees.** One login-shell call per re-detect (`PtyService.resolveLoginEnv`, cached
   with a 10 s maximum age when a re-detect asks, unbounded for spawns) returns the shell's PATH and its `command -v`
   answer for every CLI name. The search space is that PATH, then the process's, then the vendors' and package
   managers' install folders that exist off the PATH (`wellKnownBinDirs`; machine-wide ones such as `/opt/homebrew/bin`
   are injected so tests never scan the developer's machine). Sources rank `manual > path > shell > well-known >
extension bundles > desktop app`; a binary reached two ways keeps the first. Version probes run with the whole search
   space on PATH so version-manager shims can answer. Every row records the folders scanned (`capabilities.searched`).
2. **Installs are noticed.** The folders each detection scanned are watched (`CliWatchService`, non-recursive `fs.watch`,
   500 ms debounce) and trigger a re-detect, so `curl … | bash` in a terminal shows in Settings › Agents within a second.
   Settings › Agents also gains an explicit Rescan.
3. **Install from Styx, with the vendor's command.** For a CLI that is not on the machine, the Connect agent modal
   offers `Install <cli>…`: the vendor's documented command — a constant per agent and platform in core
   (`installRecipes`), never anything from the renderer — runs in the user's login shell inside the modal's terminal,
   with the command shown in a tooltip before and as the terminal label during. Native installers where they exist
   (Claude, Codex, Cursor; their PowerShell twins on Windows); Gemini through Homebrew when present, else npm; a clear
   refusal when neither is there. On exit main re-detects (the new binary is found in its install folder before any
   PATH edit takes effect), re-verifies, logs `installed (<command>)` to the Home feed, and only then reports `exited`.
4. **A path or a name can be typed.** `detect.setBinary` accepts `~/…` and bare command names resolved through the
   same search; the modal shows "Looked in n folders · Show where" so "not installed" is never a mystery.

Sign-in, verification and what is stored are unchanged (ADR-0014): the CLI's own login, its own status command, an
identity label and a location, never a token.

## Rejected

- A generic "bring your own agent" (custom ACP agents, the ACP registry): the owner meant bring your own
  _subscription_ for the four supported CLIs; new agent kinds are a separate decision.
- Isolating the installer (sandbox, our own download): the vendor's script is what their docs tell the user to run;
  running it in the user's own login shell, visibly, is the honest equivalent of the terminal.
- Watching the whole home directory: the scanned folders are a small, known set; watching them is cheap and exact.
