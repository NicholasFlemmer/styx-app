import type { Platform } from './model/common';

/**
 * Every UI string from spec §10 and the handoff README, verbatim. Placeholders use `{name}` and are
 * filled with `fill()`; platform-dependent words come from `platformCopy()`.
 */
export const copy = {
  app: { name: 'Styx', wordmark: 'STYX' },

  palette: {
    /** Accessible name of the palette dialog (not rendered). */
    dialogLabel: 'Command palette',
    /** Accessible name of the results listbox (not rendered). */
    resultsLabel: 'Results',
    placeholder: 'switch, spawn, deploy, grant, diff…',
    titlebarField: 'Switch, spawn, deploy, grant…',
    groups: { actions: 'Actions', agents: 'Agents', projects: 'Projects' },
    footer: { run: '⏎ run', newWindow: '{mod}⏎ new window', scope: '⇥ scope', close: 'esc' },
    actions: {
      deploy: 'Deploy {project} → {target}',
      grant: 'Grant {agent} → {target}',
      spawn: 'Spawn agent in {project}',
      spawnMeta: '{agent} ▾',
      newProject: 'New project…',
      newProjectMeta: 'empty · template · agent',
      /** Owner additions (not in §10, spec tone): existing repos reachable from the palette too. */
      addExisting: 'Add existing projects…',
      addExistingMeta: 'recents · scan this machine',
      openFolder: 'Open folder…',
      openFolderMeta: 'existing repo',
      cloneUrl: 'Clone URL…',
      cloneUrlMeta: 'git clone',
      switchProject: 'Switch to {project}',
    },
    meta: {
      needsYou: 'needs you',
      open: 'open · {t}',
      always: 'always',
      locked: 'locked',
      expired: 'expired',
      unconnected: 'unconnected',
    },
  },

  counters: {
    needsYou: 'Needs you',
    agentsWorking: 'Agents working',
    grantsActive: 'Grants active',
    projects: 'Projects',
    titlebarNeedsYou: '{n} needs you',
    titlebarLocked: '{n} locked',
    statusGrantsActive: '{n} grants active',
  },

  nav: {
    home: 'All projects',
    workspace: 'Workspace',
    agents: 'Agents',
    repo: 'Repo',
    approvals: 'Approvals',
    settings: 'Settings',
    worktreesMeta: '{n} wt',
  },

  board: {
    columns: { needsYou: 'Needs you', working: 'Working', done: 'Done' },
    empty: {
      needsYou: 'Nothing waiting on you.',
      working: 'No agents running. Spawn one below, or ask in the palette.',
      done: 'Finished sessions land here for 7 days.',
    },
    actions: {
      open: 'Open',
      reviewGrant: 'Review grant',
      reviewPlan: 'Review plan',
      archive: 'Archive',
      deny: 'Deny',
      spawn: '+ Spawn agent',
    },
    queued: '+{n} queued',
    states: { idle: 'Idle', paused: 'paused', working: 'working', needsYou: 'needs you', done: 'done' },
  },

  chat: {
    waitingOnYou: 'waiting on you',
    composerPlaceholder: 'Message {agent}…',
    composer: { file: '@file', command: '/command', model: 'Model ▾', send: '⏎ send' },
    /** Session menu actions (owner addition: §10 has no session-close copy). */
    sessionMenu: 'Session',
    closeSession: 'Close chat',
    poppedOut: 'Popped out',
    dock: 'Dock',
    /** Claude Code parity controls (owner addition, docs/handoff-discrepancies #54; not in §10). */
    controls: {
      permissions: 'Permissions',
      model: 'Model',
      effort: 'Effort',
      stop: 'Stop · esc',
      cycleMode: '⇧⇥ mode',
      interrupted: 'interrupted',
      /** A Bash tool call reached a cloud CLI by absolute path, skipping the shim (owner decision: warn, do not block). */
      bypassWarning:
        'warning: {cli} called by full path — this skips the Styx shim, so no grant was asked and nothing was audited',
      compacted: 'context compacted',
      modeChanged: 'permissions: {mode}',
      modelChanged: 'model: {model}',
      /** Chat meta suffix once a stream session has reported usage. */
      usage: '{cost} · {turns} turns',
      /** Short option labels for the 360px composer line (the long forms live in `session.*`; hints via title). */
      modeShort: {
        default: 'Ask',
        acceptEdits: 'Accept edits',
        plan: 'Plan',
        bypassPermissions: 'Bypass',
        dontAsk: "Don't ask",
        auto: 'Auto',
      },
      modelShort: { default: 'Default', fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' },
    },
    /** Attachments, `@` file mentions and `/` commands in the composer (owner addition, discrepancies #57; not in §10). */
    attach: {
      image: 'image',
      file: 'file',
      remove: 'Remove {name}',
      tooLarge: '{name} is larger than {max}',
      unsupported: '{name} is not a supported image (png, jpeg, gif, webp)',
      dropHint: 'Drop images or files to attach',
      pickFile: 'Attach file…',
    },
    mention: { hint: 'Files in this worktree', none: 'No matching file' },
    slash: { hint: 'Claude Code commands', none: 'No matching command' },
    /** Thinking blocks and the live working line (owner addition, docs/handoff-discrepancies #55; not in §10). */
    thinking: { streaming: 'Thinking…', done: 'Thought for {s}s', show: 'Show', hide: 'Hide' },
    working: { thinking: 'Thinking…', working: 'Working…', tool: 'Running {tool}…', elapsed: '{s}s' },
  },

  /** Appended to every Claude Code session's system prompt (owner decision: steer to the shims instead of isolating). */
  agentPrompt: {
    shims:
      'Cloud and deploy commands (gcloud, aws, gh, vercel, supabase, ssh) must run through the shims already on PATH so Styx can ask the user for a scoped grant and audit the call. Never invoke a cloud CLI by its full path, and never read its credential store directly. If a shim fails, report the error and stop instead of going around it.',
  },

  /** Claude Code session settings (owner addition, docs/handoff-discrepancies #54; not in §10). */
  session: {
    permissionModes: {
      default: 'Ask each time',
      acceptEdits: 'Accept edits',
      plan: 'Plan mode',
      bypassPermissions: 'Bypass permissions',
      dontAsk: "Don't ask",
      auto: 'Auto',
    },
    permissionModeHints: {
      default: 'Every tool call outside the allowlist asks you here.',
      acceptEdits: 'File edits run without asking; commands still ask.',
      plan: 'Read-only until you approve the plan.',
      bypassPermissions: 'Nothing asks. Only for sandboxes you trust.',
      dontAsk: 'Anything that would ask is denied instead.',
      auto: 'Claude decides what needs your approval.',
    },
    models: { default: 'Default model', fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' },
    efforts: {
      default: 'Default effort',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'Extra high',
      max: 'Max',
    },
    /** Plan-approval decision (ExitPlanMode) and clarifying questions (AskUserQuestion) from the CLI. */
    plan: {
      header: 'Plan ready for review',
      approve: 'Approve',
      reject: 'Reject',
      rejectedNote: 'Plan rejected in Styx',
    },
    question: { other: 'Other…' },
    /** An AskUserQuestion set, answered as one card (owner addition: §10 has no question copy). */
    questions: {
      header: (n: number): string => (n === 1 ? '1 question' : `${n} questions`),
      submit: 'Send answers',
      freeText: 'Or answer in your own words…',
      files: (n: number): string => (n === 1 ? '1 file' : `${n} files`),
    },
    tool: { running: '…', ok: '✓', error: '×' },
  },

  accessRequest: {
    title: 'Access request',
    header: 'Access request · {target}',
    scopeLine: 'Scope: {scopes}. No grant on file for this target.',
    review: 'Review request',
    deny: 'Deny',
  },

  grantSheet: {
    title: 'Access request',
    who: '{agent} · {branch}',
    target: '{target} / {env}',
    scopeLabel: 'Scope',
    scopes: { read: 'Read schema', write: 'Write', delete: 'Delete / drop', deploy: 'Deploy' },
    durationLabel: 'Duration',
    durations: { once: 'once', '1h': '1h', session: 'session', always: 'always' },
    prodNote:
      'Prod write requires {mfa}. Token is scoped to this session and revoked on expiry or when the session ends. Logged to audit.',
    deny: 'Deny',
    grant: 'Grant {duration}',
    grantMfa: 'Grant {duration} · {mfa}',
  },

  grantResult: {
    /** Chat system line. */
    line: 'grant: {target} · {scopes} · expires in {t}',
    linePersistent: 'grant: {target} · {scopes} · persistent',
    /** Screen-reader announcement. */
    announce: 'Granted {agent} {scopes} on {target} for {duration}',
    denied: '',
  },

  policies: {
    autoApproveStagingRead: 'Auto-approve read on any staging or preview target',
    askMfaProdWrite: 'Always ask, require {mfa} for prod write',
    idleExpiry: 'Expire grants after 1h idle',
    intro:
      'Policies are evaluated top to bottom. Project overrides in Settings win. Export as JSON to share with a team.',
    heading: 'Policies',
    addRule: '+ Rule',
    exportJson: 'Export JSON',
    matchesToday: 'matches {n} today',
    revokedThisWeek: 'revoked {n} this week',
    autoLabel: 'auto: policy #{n}',
  },

  approvals: {
    tabs: { inbox: 'Inbox', inboxCount: 'Inbox · {n}', policies: 'Policies', auditLog: 'Audit log' },
    review: 'Review',
    deny: 'Deny',
    footer: 'auto-approved today: {n} ({detail})',
    footerDetail: 'preview deploys, github reads',
  },

  audit: {
    drawerTitle: 'Audit entry',
    rows: {
      actor: 'Actor',
      target: 'Target',
      scope: 'Scope',
      duration: 'Duration',
      session: 'Session',
      worktree: 'Worktree',
      triggeredBy: 'Triggered by',
      policy: 'Policy',
    },
    copyJson: 'Copy JSON',
    revokeNow: 'Revoke now',
    none: '—',
    actions: {
      used: 'used {scope} token',
      usedAuto: 'used {scope} token (auto: policy #{n})',
      granted: 'granted {scopes} to {agent} · {duration}',
      denied: 'denied {scopes} to {agent}',
      revoked: 'revoked {agent} grant · {reason}',
      expired: 'revoked {agent} grant · {reason}',
      requested: 'requested {scopes}',
      openedPr: 'opened PR #{n}',
      mergedPr: 'merged PR #{n}',
      connected: 'connected',
      disconnected: 'disconnected',
      tested: 'tested connection',
      policyChanged: 'changed policies',
      exported: 'exported audit log',
    },
    reasons: {
      user: 'revoked by you',
      expired: 'expired',
      idle: 'idle 1h',
      'session-end': 'session ended',
      'once-used': 'single use',
      'target-removed': 'target removed',
      policy: 'policy',
    },
    durationDetail: { policySingleUse: 'policy · single use', expires: '{duration} · expires {t}' },
    triggeredBy: {
      grantSheet: 'grant sheet',
      idleTimer: 'idle timer',
      expiryTimer: 'expiry timer',
      lockGlyph: 'lock glyph',
    },
  },

  targets: {
    columns: { target: 'Target', env: 'Env', policy: 'Policy', state: 'State' },
    policy: { 'ask-mfa': 'Ask · MFA', ask: 'Ask each time', always: 'Always allow' },
    state: {
      locked: 'locked',
      persistent: 'persistent',
      expired: 'expired',
      unconnected: 'unconnected',
      open: 'open · {t} left',
    },
    actions: { revoke: 'Revoke', edit: 'Edit', connect: 'Connect', refresh: 'Refresh' },
    /** Settings › Targets affordance for repo-authored grant policies (security audit H-1). */
    acceptProjectPolicies: 'Accept project policies',
    statusBar: {
      open: '{target} · open {t}',
      locked: '{target} · locked',
      persistent: '{target} · persistent',
    },
    connectRow: '+ Connect target · OAuth / key / SSH',
  },

  empty: {
    projects: {
      headline: 'No projects yet.',
      body: "Add a folder or clone a repo. Agents and targets attach to projects, so Styx asks about those when they're first needed.",
      /** Prototype body (visuals win, ADR-0012). */
      bodyPrototype:
        "Start something new, add a folder, or clone a repo. Agents and targets attach to projects, so Styx asks about those when they're first needed.",
      scan: 'Scan this machine',
      newProject: 'New project',
      openFolder: 'Open folder',
      cloneUrl: 'Clone URL',
    },
    needsYou: 'Nothing waiting on you.',
    working: 'No agents running. Spawn one below, or ask in the palette.',
    done: 'Finished sessions land here for 7 days.',
    targets:
      'No targets connected. Agents can still work locally; the first time one asks for a deploy or server, Styx opens this connect flow inline.',
    noProject: 'No project',
  },

  errors: {
    authExpired: {
      text: '{target}: credentials expired {t} ago. Agents requesting it are paused.',
      cta: 'Reconnect',
    },
    cliMissing: {
      text: '{cli} not found on PATH. {n} session(s) cannot start.',
      textOne: '{cli} not found on PATH. 1 session cannot start.',
      cta: 'Install guide',
    },
    conflict: {
      text: '{branch} conflicts with main in {file}. {agent} is paused until resolved.',
      cta: 'Resolve',
    },
    /** Repo-authored grant policy is advisory until accepted on this machine (security audit H-1). */
    projectPolicyUntrusted: {
      text: "{project}'s .styx/project.json wants to change grant policies. Review in Settings.",
      cta: 'Review',
    },
    /** The CLI runs but its default model needs a newer release (`cli-outdated:<agent>` banner). */
    cliOutdated: {
      text: "Claude Code {version} can't use your default model. Update it (claude update) or switch the model in Settings.",
      cta: 'Install guide',
    },
    spawnCliMissing: '{cli} CLI not found on PATH.',
    locateBinary: 'Locate binary',
  },

  onboarding: {
    steps: { editor: 'Editor', projects: 'Projects', agents: 'Agents', targets: 'Targets' },
    /** Accessible name of the step strip (spec §9); not a §10 string. */
    stepsLabel: 'Steps',
    editor: {
      headline: 'Connect your editor.',
      body: 'Styx embeds its own editor for reviewing and editing agent work. Connecting your IDE imports recents, keybindings and theme, and sets where "Open in…" goes. Nothing in your IDE changes.',
      importKeybindings: 'Import keybindings',
      importTheme: 'Import theme & font',
      importRecents: 'Import recent folders (feeds next step)',
      installOpenIn: 'Install "Open in Styx" command',
      roleFallback: 'Fallback · Open in',
      roleDetected: 'Detected',
    },
    projects: {
      headline: 'Found {n} repos on this machine.',
      body: 'Pick the ones Styx should manage. {ide} recents and workspaces are included. Nothing is modified.',
      addRow: '+ new project · add folder · clone URL',
      /** The add row's three segments (same rendered text as `addRow`; each is its own action). */
      addRowNew: '+ new project',
      addRowFolder: 'add folder',
      addRowClone: 'clone URL',
      addRowSep: ' · ',
    },
    agents: {
      headline: 'Detected agent CLIs.',
      body: "Styx runs the CLIs you already have. Sign-in happens in the CLI's own flow; Styx only stores where it lives.",
      signedIn: 'signed in',
      signIn: 'Sign in →',
      install: 'Install →',
      notFound: 'not found on PATH',
    },
    targets: {
      headline: 'Connect deploy and server targets.',
      body: 'Optional now. Secrets go to the {keychainName}, never into a repo. Every agent use is a scoped, expiring grant.',
      tile: '{method} · connect →',
    },
    footer: { back: 'Back', skip: 'Skip', continue: 'Continue', finish: 'Finish' },
  },

  connect: {
    title: 'Connect target · {step}',
    stepPick: 'choose provider',
    methods: { cli: 'Provider CLI', oauth: 'OAuth', key: 'IAM / key', ssh: 'SSH' },
    /** Primary path: reuse the login the provider's CLI already holds; keys stay under Advanced. */
    cli: {
      /** Method-step title and onboarding tile: `gcloud CLI`. */
      method: '{cli} CLI',
      heading: 'Connect with {cli}',
      body: "Uses the account you're signed into in {cli}. Styx never sees the password; each grant asks {cli} for a short-lived token. Anything running as you can also use {cli}, so prefer scoped roles for prod.",
      notInstalled: '{cli} is not installed. Install it, or use Advanced to paste a key.',
      /** Status row when the binary is missing: `gcloud · not found on PATH · Install guide`. */
      notFound: 'not found on PATH',
      installGuide: 'Install guide',
      notLoggedIn: 'No account signed in. Run {command} to sign in.',
      account: 'Account',
      /** Row detail for the account the CLI currently uses. */
      active: 'active',
      login: 'Sign in with {cli}…',
      loginRunning: 'Running {command}…',
      waiting: 'Waiting for {command}…',
      loginDone: 'Signed in. Pick the account to use.',
      loginFailed: '{command} exited with code {code}.',
      name: 'Name',
      nameOptional: 'optional',
      connect: 'Connect',
      advanced: 'Advanced',
      advancedHint: 'key, service account or token',
      test: 'Test connection',
      save: 'Save',
      /** Settings › Targets meta line for CLI-backed targets: `via gcloud · nic@acme.dev`. */
      via: 'via {cli} · {account}',
    },
    environment: 'Environment',
    oauth: {
      body: 'Styx opens your browser to authorize. The token lands in the {keychainName}; agents receive short-lived scoped tokens derived from it.',
      waiting: 'Waiting for browser…',
      open: 'Open browser',
    },
    key: {
      body: 'Paste credentials for a role scoped to this project. Styx recommends a dedicated IAM role with no delete permissions; the key is stored in the {keychainName} and never shown again.',
      name: 'Name',
      accessKey: 'Access key / service account',
      secret: 'Secret',
      test: 'Test connection',
      save: 'Save to {keychainShort}',
    },
    ssh: {
      host: 'Host',
      user: 'User',
      key: 'Key',
      browse: 'Browse',
      body: "Agents get a forwarded agent socket for the grant's duration, never the key file.",
      test: 'Test connection',
      save: 'Save',
    },
    back: 'Back',
  },

  newProject: {
    title: 'New project',
    name: 'Name',
    location: 'Location',
    browse: 'Browse',
    startFrom: 'Start from',
    starts: {
      empty: { label: 'Empty folder', desc: 'Just git init and a README.' },
      template: { label: 'Template', desc: 'Built-in stacks or repos tagged in your org.' },
      agent: {
        label: 'Agent scaffolds it',
        desc: 'Describe it; the agent builds the skeleton and pauses for review.',
      },
    },
    templateLabel: 'Template',
    templateNote:
      'Templates are git repos tagged styx-template in your GitHub org, plus built-ins (Node, Python, Go, Rust, static).',
    briefLabel: 'Brief for {agent}',
    agentNote:
      'The agent scaffolds in an empty worktree on main, then pauses for your review before the first commit.',
    gitInit: 'git init',
    createGithubRepo: 'Create GitHub repo · private',
    connectGithub: 'Connect GitHub to create the remote',
    copyTargets: 'Copy targets from {project}',
    openInIde: 'Open in {ide} too',
    githubNote: '{target} · persistent grant · repo will be {repo}',
    cancel: 'Cancel',
    create: 'Create · {mod}⏎',
    createSpawn: 'Create · spawn {agent} · {mod}⏎',
    /** Clone mode (owner addition, not in §10; spec tone): URL · Location · Open in {IDE} too · Cancel / Clone. */
    clone: {
      title: 'Clone repository',
      url: 'URL',
      urlPlaceholder: 'git@github.com:org/repo.git',
      clone: 'Clone · {mod}⏎',
      cloning: 'Cloning {repo}…',
      failed: 'Clone failed: {message}',
    },
  },

  spawn: {
    title: 'Spawn agent · {project}',
    worktree: 'Worktree',
    worktreeDefault: 'New from main',
    /** Plain-folder projects (no git): the only worktree option; `New from main` is disabled. */
    worktreeFolder: 'This folder (no worktree isolation)',
    branch: 'Branch',
    firstMessage: 'First message',
    firstMessagePlaceholder: 'What should {agent} do? Reference files with @.',
    toggles: {
      autoApproveEdits: 'Auto-approve edits',
      mayRequestTargets: 'May request targets',
      notifyWhenNeedsMe: 'Notify when it needs me',
    },
    cancel: 'Cancel',
    spawn: 'Spawn · {mod}⏎',
  },

  toast: {
    header: 'Needs you',
    source: 'Styx · now',
    title: '{agent} wants {target} · {scope}',
    meta: '{project} · {branch} · "{reason}"',
    review: 'Review',
    later: 'Later',
    osTitle: '{agent} needs you',
  },

  repo: {
    title: 'Worktrees',
    remoteLine: '{remote} · {branch} ↑{ahead} ↓{behind}',
    fetch: 'Fetch',
    addWorktree: '+ Worktree',
    columns: { branch: 'Branch', owner: 'Owner', changes: 'Changes', pr: 'PR' },
    you: 'you',
    changes: {
      clean: 'clean · ↑{ahead} ↓{behind}',
      summary: '+{added} −{removed} · {files} {filesWord}',
      waitingOnGrant: 'waiting on grant',
      merged: 'merged {when}',
      conflict: 'CONFLICT · {file} vs {against}',
    },
    pr: { none: '—', draft: '#{n} draft', open: '#{n} open', merged: '#{n} ✓', closed: '#{n} closed' },
    actions: { open: 'Open', diff: 'Diff', archive: 'Archive', resolve: 'Resolve' },
    /**
     * Plain-folder empty state (owner decision, not in §10; spec tone): any folder is a project, git is optional.
     * Shown on Repo and Diff review; `Initialise git` runs `project.gitInit`.
     */
    noGit: {
      label: 'Not a git repository',
      body: 'Agents work in this folder directly. Initialise git to get isolated worktrees, diffs and reviews.',
      cta: 'Initialise git',
    },
  },

  diff: {
    title: 'Review',
    meta: '{agent} · {branch} · {summary}',
    summary: '{accepted} accepted · {rejected} rejected · {pending} pending',
    acceptAll: 'Accept all',
    rejectAll: 'Reject all',
    done: 'Done',
    accept: 'Accept',
    reject: 'Reject',
    review: 'Review',
    files: 'Files · {n}',
    keys: {
      title: 'Keys',
      acceptReject: 'a accept · r reject',
      nextPrev: 'j / k next · prev',
      done: '{mod}⏎ done',
    },
    hunkBar: '{n} hunks from {agent} · {note}',
    hunkLabel: '{agent} · {age}',
    changesHeader: 'Changes · {n}',
  },

  workspace: {
    files: 'Files',
    /** ✕ on an editor file tab (owner addition: §10 has no close affordance). */
    closeFile: (name: string): string => `Close ${name}`,
    openIn: 'Open in {ide}',
    terminal: 'TERMINAL · {branch}',
    editorStatus: 'Monaco · {eol} · {lang}',
    /** Editor readout appended to the prototype's status text (owner addition, discrepancies #58; not in §10). */
    editorCursor: 'Ln {line}, Col {col}',
    editorWrap: 'Wrap',
    editorReadOnly: { binary: 'Binary file', large: 'Large file · read-only' },
    /** Status bar / scan meta in place of a branch when the folder is not a git repository. */
    noGit: 'no git',
  },

  settings: {
    groups: { app: 'App', project: 'Project · {project}' },
    app: {
      general: 'General',
      editor: 'Editor',
      agents: 'Agents & CLIs',
      keychain: 'Keychain & secrets',
      policies: 'Policies',
      shortcuts: 'Shortcuts',
    },
    project: { targets: 'Targets', agentDefaults: 'Agent defaults', env: 'Env & secrets' },
    footer: { file: '.styx/project.json', note: 'committed · secrets excluded' },
    scope: { app: 'app', project: 'project · {project}' },
    rows: {
      theme: 'Theme',
      notify: 'Notify when an agent needs me',
      launchAtLogin: 'Launch at login',
      engine: 'Engine',
      openFilesIn: 'Open files in',
      fallbackEditor: 'Fallback editor',
      lineEndings: 'Line endings',
      /** Spec §9: Monaco screen-reader mode + xterm accessibility tree; not a §10 string. */
      screenReader: 'Screen reader mode',
      defaultAgent: 'Default agent',
      autoWorktree: 'Auto-create worktree per agent',
      shellWindows: 'Shell (Windows)',
      detectedClis: 'Detected CLIs',
      /** One row per CLI with more than one runnable binary (PATH vs an IDE extension bundle …). */
      cliBinary: '{cli} binary',
      store: 'Store',
      mfaProdWrite: 'MFA for prod write',
      injectAs: 'Inject as',
      autoApproveStagingReads: 'Auto-approve staging reads',
      grantIdleExpiry: 'Grant idle expiry',
      export: 'Export',
      palette: 'Palette',
      switchProject: 'Switch project',
      focusAgent: 'Focus agent 1–4',
      approveDeny: 'Approve / deny',
      model: 'Model',
      autoApproveEdits: 'Auto-approve edits',
      /** Claude Code session defaults (owner addition, docs/handoff-discrepancies #54; not in §10). */
      permissionMode: 'Permission mode',
      effort: 'Effort',
      envSource: '.env source',
      shareWithAgents: 'Share with agents',
      committedFile: 'Committed file',
    },
    values: {
      theme: { system: 'System', dark: 'Dark', light: 'Light' },
      notify: { 'badge-sound': 'Badge + sound', badge: 'Badge', off: 'Off' },
      on: 'On',
      off: 'Off',
      engine: 'Monaco (embedded)',
      openFilesIn: { styx: 'Styx', fallback: 'Fallback editor' },
      lineEndings: { auto: 'Per repo', lf: 'LF', crlf: 'CRLF' },
      shellWindows: { powershell: 'PowerShell', wsl: 'WSL' },
      injectAs: { 'scoped-else-env': 'Scoped token, else env', env: 'Env' },
      idleExpiry: '1 hour',
      exportJson: 'JSON',
      modelDefault: 'Default',
      envSource: 'Keychain',
      shareWithAgents: { 'per-grant': 'Per grant', always: 'Always', never: 'Never' },
      committedFile: '.styx/project.json',
    },
    reset: 'Reset',
  },

  agents: { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', cursor: 'Cursor', shell: 'shell' },
  /** Where a detected CLI binary lives (Settings › Agents & CLIs, onboarding step 3). */
  cliSources: {
    path: 'PATH',
    'vscode-extension': 'VS Code extension',
    'cursor-extension': 'Cursor extension',
    'desktop-app': 'Claude app',
    manual: 'located manually',
  },
  agentProducts: {
    claude: 'Claude Code',
    codex: 'Codex',
    gemini: 'Gemini CLI',
    cursor: 'Cursor agent',
    shell: 'Shell',
  },
  providers: {
    vercel: 'Vercel',
    aws: 'AWS',
    gcp: 'GCP',
    supabase: 'Supabase',
    github: 'GitHub',
    ssh: 'SSH host',
  },

  home: {
    columns: {
      project: 'Project',
      path: 'Path',
      branch: 'Branch',
      agents: 'Agents',
      targets: 'Targets',
      last: 'Last activity',
    },
    addRow: {
      newProject: '+ New project',
      addExisting: '+ Add existing',
      openFolder: '+ Open folder',
      cloneUrl: '+ Clone URL',
    },
    activity: 'Activity',
  },

  /** Rail "+" menu (owner addition, not in §10): the three ways a project enters Styx. */
  rail: {
    add: 'Add project',
    /** Right-click menu on a project tile (owner addition: §10 has no rail context menu). */
    projectMenu: 'Project',
    remove: 'Remove from sidebar',
    menu: {
      newProject: 'New project…',
      addExisting: 'Add existing…',
      openFolder: 'Open folder…',
      cloneUrl: 'Clone URL…',
    },
  },

  /**
   * "Add existing projects" modal (owner addition, docs/handoff-discrepancies #53): the onboarding step-2 list
   * (editor recents + repos found on this machine) reachable any time after onboarding.
   */
  addExisting: {
    title: 'Add existing projects',
    lead: 'Recent folders from your editor and repos found on this machine. Projects already in Styx are hidden.',
    scanning: 'Scanning this machine…',
    empty: 'Nothing new to add. Every recent folder and repo found here is already a project.',
    failed: 'Scan failed: {message}',
    rescan: 'Rescan',
    openFolder: 'Open folder…',
    add: 'Add {n}',
    addNone: 'Add',
  },

  window: { popout: '⤢', dock: 'Dock', minimize: '─', maximize: '☐', close: '✕' },

  general: {
    cancel: 'Cancel',
    close: '✕',
    none: '—',
    yes: 'Yes',
    no: 'No',
    editPlan: 'Edit plan',
    later: 'Later',
  },
} as const;

export type Copy = typeof copy;

export interface PlatformCopy {
  mfa: 'Touch ID' | 'Windows Hello';
  mfaFallback: 'password' | 'PIN';
  mod: '⌘' | 'Ctrl';
  keychainName: 'macOS Keychain' | 'Windows Credential Manager';
  keychainShort: 'Keychain' | 'Credential Manager';
  defaultProjectDir: '~/code' | 'C:\\dev';
  shell: 'zsh' | 'PowerShell';
}

/** Platform words (spec §7). */
export const platformCopy = (platform: Platform): PlatformCopy =>
  platform === 'win32'
    ? {
        mfa: 'Windows Hello',
        mfaFallback: 'PIN',
        mod: 'Ctrl',
        keychainName: 'Windows Credential Manager',
        keychainShort: 'Credential Manager',
        defaultProjectDir: 'C:\\dev',
        shell: 'PowerShell',
      }
    : {
        mfa: 'Touch ID',
        mfaFallback: 'password',
        mod: '⌘',
        keychainName: 'macOS Keychain',
        keychainShort: 'Keychain',
        defaultProjectDir: '~/code',
        shell: 'zsh',
      };

/** Fill `{name}` placeholders. Unknown placeholders are left as-is so missing values are visible. */
export const fill = (template: string, vars: Record<string, string | number>): string =>
  template.replaceAll(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));

/** Default project location for a new project name (spec §4.12). */
export const defaultProjectLocation = (name: string, platform: Platform): string =>
  platform === 'win32' ? `C:\\dev\\${name}` : `~/code/${name}`;

/** `git@github.com:acme/shop.git` · `https://github.com/acme/shop/` · `/srv/git/shop` → `shop`; '' when nothing usable. */
export const repoNameOfUrl = (url: string): string => {
  const last = url
    .trim()
    .replace(/[/\\]+$/, '')
    .split(/[/:\\]/)
    .pop();
  return (last ?? '').replace(/\.git$/i, '');
};

/** Clone destination for a URL: `~/code/<repo>` (`C:\dev\<repo>` on Windows); the bare root when the URL has no name yet. */
export const defaultCloneLocation = (url: string, platform: Platform): string => {
  const name = repoNameOfUrl(url);
  return platform === 'win32' ? `C:\\dev${name ? `\\${name}` : ''}` : `~/code${name ? `/${name}` : ''}`;
};
