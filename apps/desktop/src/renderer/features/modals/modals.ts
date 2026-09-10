import {
  cliVersionLabel as coreCliVersionLabel,
  copy,
  fill,
  mainWorktreeOf,
  projectHasGit,
  projectSettingsOfOrDefault,
  rows,
  type Agent,
  type AuthMethod,
  type CliInstall,
  type CommandInput,
  type CommandOutput,
  type Effort,
  type Env,
  type IdeInstall,
  type PermissionMode,
  type Platform,
  type ProjectId,
  type Provider,
  type ReadModel,
  type SessionToggles,
  type Target,
  type Worktree,
} from '@styx/core';

/** Prototype order of the provider grid (spec §4.9 / §4.10). */
export const PROVIDERS: readonly Provider[] = ['vercel', 'aws', 'gcp', 'supabase', 'github', 'ssh'];

/** `methodOf` in the prototype state script: AWS/GCP → key, SSH host → ssh, everything else → OAuth. */
export const methodOf = (provider: Provider): AuthMethod =>
  provider === 'aws' || provider === 'gcp' ? 'key' : provider === 'ssh' ? 'ssh' : 'oauth';

export const methodLabel = (provider: Provider): string => copy.connect.methods[methodOf(provider)];

/** The provider's own CLI (`gcloud auth login`, `gh auth login` …); SSH has none. */
export const CLI_OF: Readonly<Record<Exclude<Provider, 'ssh'>, string>> = {
  vercel: 'vercel',
  aws: 'aws',
  gcp: 'gcloud',
  supabase: 'supabase',
  github: 'gh',
};

export const providerCli = (provider: Provider): string | null =>
  provider === 'ssh' ? null : CLI_OF[provider];

/** Primary connect path: the provider's CLI for everything but SSH (which stays the SSH form). */
export const primaryStepOf = (provider: Provider): ConnectStep => (provider === 'ssh' ? 'ssh' : 'cli');

/** Tile / title label of the primary path: `gcloud CLI` · `SSH`. */
export const cliMethodLabel = (provider: Provider): string => {
  const cli = providerCli(provider);
  return cli === null ? copy.connect.methods.ssh : fill(copy.connect.cli.method, { cli });
};

export type ConnectStep = 'pick' | AuthMethod;

export type CliStatus = CommandOutput<'target.connect.cliStatus'>;
export type CliAccount = CliStatus['accounts'][number];

/** `gcloud 512.0.0` · `gcloud · not found on PATH`. */
export const cliStatusLine = (cli: string, status: CliStatus | null): string => {
  if (status === null || !status.installed) return `${cli} · ${copy.connect.cli.notFound}`;
  const binary = status.binary ?? cli;
  return status.version === null ? binary : `${binary} ${status.version}`;
};

/** The account the modal preselects: the CLI's active one, else the first. */
export const defaultAccount = (status: CliStatus | null): string | null =>
  status === null ? null : (status.accounts.find((a) => a.active)?.id ?? status.accounts[0]?.id ?? null);

/** `AWS acme-prod` · `GCP nic@acme.dev`: provider + account label when no name is typed. */
export const cliTargetName = (provider: Provider, account: CliAccount | undefined, name: string): string => {
  const typed = name.trim();
  if (typed !== '') return typed;
  const p = copy.providers[provider];
  return account === undefined || account.label.trim() === '' ? p : `${p} ${account.label.trim()}`;
};

export const cliSavePayload = (
  projectId: ProjectId,
  provider: Provider,
  env: Env,
  status: CliStatus,
  accountId: string,
  name: string,
): CommandInput<'target.connect.cliSave'> => ({
  projectId,
  provider,
  env,
  name: cliTargetName(
    provider,
    status.accounts.find((a) => a.id === accountId),
    name,
  ),
  account: accountId,
  config: {},
});

export const isCliTarget = (target: Target): boolean => target.authMethod === 'cli';

/** Settings › Targets meta for CLI-backed targets: `via gcloud · nic@acme.dev` (account from `cliSave`'s config). */
export const cliTargetMeta = (target: Target): string | null => {
  const cli = providerCli(target.provider);
  if (!isCliTarget(target) || cli === null) return null;
  const account = target.config['account'];
  return fill(copy.connect.cli.via, {
    cli,
    account: typeof account === 'string' && account !== '' ? account : copy.general.none,
  });
};

/** Connect env chips (prototype `envs`): prod · staging · preview. */
export const CONNECT_ENVS: readonly Extract<Env, 'prod' | 'staging' | 'preview'>[] = [
  'prod',
  'staging',
  'preview',
];

export interface KeyForm {
  name: string;
  accessKey: string;
  secret: string;
}
export const keyFormValid = (f: KeyForm): boolean =>
  f.name.trim() !== '' && f.accessKey.trim() !== '' && f.secret !== '';

export interface SshForm {
  host: string;
  user: string;
  keyPath: string;
  /** Blank means the default 22; bastions and forwarded hosts routinely sit elsewhere. */
  port: string;
  /** Optional: only encrypted keys need one. */
  passphrase: string;
}
export const sshFormValid = (f: SshForm): boolean =>
  f.host.trim() !== '' && f.user.trim() !== '' && f.keyPath.trim() !== '' && sshPort(f) !== null;

/** The port a form means: blank is 22; anything not a port number is invalid (null blocks save). */
export const sshPort = (f: SshForm): number | null => {
  const raw = f.port.trim();
  if (raw === '') return 22;
  if (!/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : null;
};

/** SSH targets are named after the host (the prototype shows no Name field on the SSH step). */
export const sshTargetName = (f: SshForm): string => f.host.trim();

// --- Spawn ---------------------------------------------------------------

export const SPAWN_AGENTS: readonly Agent[] = ['claude', 'codex', 'gemini', 'cursor', 'shell'];

/** Tile subtitle: `claude 2.4.1` / `cursor-agent 0.5.2` / `zsh 5.9`; unknown or missing binaries read `not found on PATH`. */
export const cliVersionLabel = (cli: CliInstall | undefined): string =>
  cli === undefined ? copy.onboarding.agents.notFound : coreCliVersionLabel(cli);

export const cliOf = (model: ReadModel, agent: Agent): CliInstall | undefined =>
  model.discovery.clis.find((c) => c.agent === agent);

export const cliMissing = (model: ReadModel, agent: Agent): boolean => {
  const cli = cliOf(model, agent);
  return cli !== undefined && !cli.found;
};

/** Worktrees of a project, main first. */
export const projectWorktrees = (model: ReadModel, projectId: ProjectId): Worktree[] =>
  rows(model.worktrees)
    .filter((w) => w.projectId === projectId)
    .sort((a, b) => Number(b.isMain) - Number(a.isMain));

/** `agent/<name>-<n>` (spec §4.11): prefix from project settings, n = first free counter among existing branches. */
export const autoBranch = (agent: Agent, prefix: string, existingBranches: readonly string[]): string => {
  const name = copy.agentProducts[agent].toLowerCase().split(' ')[0] ?? agent;
  const taken = new Set<number>();
  const re = new RegExp(`^${prefix.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}${name}-(\\d+)$`);
  for (const b of existingBranches) {
    const m = re.exec(b);
    if (m?.[1] !== undefined) taken.add(Number(m[1]));
  }
  let n = 1;
  while (taken.has(n)) n += 1;
  return `${prefix}${name}-${n}`;
};

export const autoBranchFor = (model: ReadModel, projectId: ProjectId, agent: Agent): string =>
  autoBranch(
    agent,
    projectSettingsOfOrDefault(model, projectId).branchPrefix,
    projectWorktrees(model, projectId).flatMap((w) => (w.branch === null ? [] : [w.branch])),
  );

/**
 * Worktree select rows and the default pick. Git repos: `New from main` (default) plus the agent worktrees. A plain
 * folder has no worktree isolation: its main worktree is the only pick (`This folder (no worktree isolation)`) and
 * `New from main` is listed disabled until `git init`.
 */
export const worktreeChoices = (
  model: ReadModel,
  projectId: ProjectId,
): {
  options: { value: string; label: string; disabled?: boolean }[];
  initial: string;
  plainFolder: boolean;
} => {
  if (projectHasGit(model, projectId)) {
    const worktrees = projectWorktrees(model, projectId).filter((w) => !w.isMain);
    return {
      options: [
        { value: 'new', label: copy.spawn.worktreeDefault },
        ...worktrees.map((w) => ({ value: w.id, label: w.branch ?? copy.general.none })),
      ],
      initial: 'new',
      plainFolder: false,
    };
  }
  const main = mainWorktreeOf(model, projectId);
  const folder = main === null ? 'new' : main.id;
  return {
    options: [
      ...(main === null ? [] : [{ value: main.id, label: copy.spawn.worktreeFolder }]),
      { value: 'new', label: copy.spawn.worktreeDefault, disabled: true },
    ],
    initial: folder,
    plainFolder: true,
  };
};

export const defaultToggles = (model: ReadModel, projectId: ProjectId): SessionToggles => {
  const s = projectSettingsOfOrDefault(model, projectId);
  return {
    autoApproveEdits: s.autoApproveEdits,
    mayRequestTargets: s.mayRequestTargets,
    notifyWhenNeedsMe: s.notifyWhenNeedsMe,
  };
};

/** Claude Code session settings on the spawn form (owner addition, discrepancy #54); `null` = the CLI's default. */
export interface SpawnSessionSettings {
  permissionMode: PermissionMode;
  model: string | null;
  effort: Effort | null;
}

/** Project defaults (`.styx/project.json` `agents.*`, else app defaults) seed the spawn selects. */
export const defaultSessionSettings = (model: ReadModel, projectId: ProjectId): SpawnSessionSettings => {
  const s = projectSettingsOfOrDefault(model, projectId);
  return { permissionMode: s.permissionMode, model: s.model, effort: s.effort };
};

export interface SpawnForm extends SpawnSessionSettings {
  agent: Agent;
  /** 'new' = New from main; otherwise an existing worktree id. */
  worktree: string;
  branch: string;
  firstMessage: string;
  toggles: SessionToggles;
}

/** Settings an agent cannot take fall back to the CLI defaults (only Claude has modes/effort; Cursor takes a model). */
export const sessionSettingsFor = (agent: Agent, s: SpawnSessionSettings): SpawnSessionSettings => ({
  permissionMode: agent === 'claude' ? s.permissionMode : 'default',
  model: agent === 'claude' || agent === 'cursor' ? s.model : null,
  effort: agent === 'claude' ? s.effort : null,
});

export const spawnPayload = (
  model: ReadModel,
  projectId: ProjectId,
  f: SpawnForm,
): CommandInput<'session.spawn'> => {
  const existing = projectWorktrees(model, projectId).find((w) => w.id === f.worktree);
  const worktree: CommandInput<'session.spawn'>['worktree'] =
    f.worktree !== 'new' && existing !== undefined
      ? { kind: 'existing', worktreeId: existing.id }
      : {
          kind: 'new',
          base: projectSettingsOfOrDefault(model, projectId).baseBranch,
          branch: f.branch.trim(),
        };
  const settings = sessionSettingsFor(f.agent, f);
  return {
    projectId,
    agent: f.agent,
    worktree,
    firstMessage: f.firstMessage,
    toggles: f.toggles,
    model: settings.model,
    permissionMode: settings.permissionMode,
    effort: settings.effort,
  };
};

export const spawnValid = (model: ReadModel, f: SpawnForm): boolean =>
  !cliMissing(model, f.agent) && (f.worktree !== 'new' || f.branch.trim() !== '');

// --- New project ---------------------------------------------------------

export type StartFrom = 'empty' | 'template' | 'agent';
export const START_FROM: readonly StartFrom[] = ['empty', 'template', 'agent'];

/** Built-in templates (spec §4.12); org templates are appended when discovery provides them. */
export const BUILTIN_TEMPLATES: readonly { value: string; label: string }[] = [
  { value: 'node', label: 'Node' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'static', label: 'static' },
];

export interface NewProjectForm {
  name: string;
  location: string;
  startFrom: StartFrom;
  template: string;
  brief: string;
  gitInit: boolean;
  createGithubRepo: boolean;
  copyTargets: boolean;
  openInIde: boolean;
}

export const githubTargetOf = (model: ReadModel, projectId: ProjectId | null): Target | undefined =>
  projectId === null
    ? undefined
    : rows(model.targets).find((t) => t.projectId === projectId && t.provider === 'github');

/** The IDE "Open in … too" points at: the fallback IDE, else app setting, else nothing. */
export const fallbackIde = (model: ReadModel): IdeInstall | undefined =>
  model.discovery.ides.find((i) => i.isFallback) ??
  model.discovery.ides.find((i) => i.kind === model.settings.app.fallbackIde);

export const newProjectValid = (f: NewProjectForm): boolean => {
  if (f.name.trim() === '' || f.location.trim() === '') return false;
  if (f.startFrom === 'template') return f.template !== '';
  if (f.startFrom === 'agent') return f.brief.trim() !== '';
  return true;
};

export const newProjectPayload = (f: NewProjectForm, agent: Agent, copyTargetsFrom: ProjectId | null) => ({
  name: f.name.trim(),
  location: f.location.trim(),
  startFrom:
    f.startFrom === 'empty'
      ? ({ kind: 'empty' } as const)
      : f.startFrom === 'template'
        ? ({ kind: 'template', template: f.template } as const)
        : ({ kind: 'agent', agent, brief: f.brief.trim() } as const),
  gitInit: f.gitInit,
  createGithubRepo: f.createGithubRepo,
  copyTargetsFrom: f.copyTargets ? copyTargetsFrom : null,
  openInIde: f.openInIde,
});

/** `GitHub acme · persistent grant · repo will be acme/orders-service`. */
export const githubNote = (target: Target, name: string): string => {
  const owner = typeof target.config['owner'] === 'string' ? target.config['owner'] : null;
  return fill(copy.newProject.githubNote, {
    target: owner === null ? target.name : `${copy.providers.github} ${owner}`,
    repo: owner === null ? name : `${owner}/${name}`,
  });
};

export const createLabel = (startFrom: StartFrom, agent: Agent, platform: Platform, mod: string): string =>
  startFrom === 'agent'
    ? fill(copy.newProject.createSpawn, { agent: copy.agentProducts[agent], mod })
    : fill(copy.newProject.create, { mod, platform });
