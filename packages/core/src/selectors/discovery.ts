import { copy } from '../copy';
import type { CliInstall, IdeInstall } from '../model/discovery';

/** Onboarding step 1 "version · location" cell: "1.98 · /Applications", "1.4", "not found". */
export const ideVersionLabel = (ide: Pick<IdeInstall, 'version' | 'location'>): string => {
  if (ide.version === null) return copy.onboarding.agents.notFound;
  return ide.location === null ? ide.version : `${ide.version} · ${ide.location}`;
};

/** Importable items: "14 recents · keybindings · theme", "3 recents", "recents via shada", "—". */
export const ideImportsLabel = (ide: Pick<IdeInstall, 'imported' | 'recentsSource'>): string => {
  const parts: string[] = [];
  if (ide.imported.recents > 0) parts.push(`${ide.imported.recents} recents`);
  else if (ide.recentsSource === 'shada') parts.push('recents via shada');
  if (ide.imported.keybindings) parts.push('keybindings');
  if (ide.imported.theme) parts.push('theme');
  return parts.length === 0 ? copy.general.none : parts.join(' · ');
};

/** Onboarding step 3 auth cell: "signed in" · "Sign in →" · "Install →" · "—". */
export const cliAuthLabel = (cli: Pick<CliInstall, 'found' | 'authState'>): string => {
  if (!cli.found) return copy.onboarding.agents.install;
  switch (cli.authState) {
    case 'signed-in':
      return copy.onboarding.agents.signedIn;
    case 'signed-out':
    case 'unknown':
      return copy.onboarding.agents.signIn;
    case 'n/a':
      return copy.general.none;
  }
};

/** Onboarding step 3 version cell: "claude 2.4.1", "not found on PATH". */
export const cliVersionLabel = (cli: Pick<CliInstall, 'agent' | 'found' | 'version' | 'binary'>): string => {
  if (!cli.found) return copy.onboarding.agents.notFound;
  const base = cli.binary
    ?.split('/')
    .filter((seg) => seg.length > 0)
    .pop();
  const name = base === undefined ? cli.agent : base;
  return cli.version === null ? name : `${name} ${cli.version}`;
};
