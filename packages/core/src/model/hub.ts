import { z } from 'zod';
import { projectIdSchema, sessionIdSchema } from './common';

/**
 * The team hub (ADR-0032): home base for a team's spaces, threads, shared lanes and context; Styx desktop is the
 * pilot seat. Main owns this state (HubService) and re-sends it whole on every change. Nothing here is a secret:
 * the hub's tokens live in the OS keychain and never reach this model, SQLite, a log or the renderer.
 */

export const hubSpaceRoleSchema = z.enum(['owner', 'member', 'viewer']);
export type HubSpaceRole = z.infer<typeof hubSpaceRoleSchema>;

export const hubSpaceSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  name: z.string().min(1),
  role: hubSpaceRoleSchema,
  /** Whether what agents propose waits for a person (`review`) or lands at once (`auto`). */
  agentProposals: z.enum(['review', 'auto']),
});
export type HubSpace = z.infer<typeof hubSpaceSchema>;

export const hubTeamSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  domain: z.string().min(1),
  role: z.enum(['admin', 'member']),
});
export type HubTeam = z.infer<typeof hubTeamSchema>;

export const hubAccountSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(1),
  name: z.string().nullable(),
});
export type HubAccount = z.infer<typeof hubAccountSchema>;

export const hubConnectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('signed-out'), error: z.string().nullable() }),
  z.object({
    kind: z.literal('signing-in'),
    userCode: z.string(),
    verificationUri: z.string(),
    expiresAt: z.number(),
  }),
  z.object({
    kind: z.literal('signed-in'),
    account: hubAccountSchema,
    teams: z.array(hubTeamSchema),
    spaces: z.array(hubSpaceSchema),
    /** First failed reach since the last good one; null while the hub answers. Offline is a note, not an ending. */
    staleSince: z.number().nullable(),
  }),
]);
export type HubConnection = z.infer<typeof hubConnectionSchema>;

/** A local project linked to a space: where its lanes' shares go (ADR-0032 section 3). Shares nothing by itself. */
export const hubLinkSchema = z.object({
  projectId: projectIdSchema,
  spaceId: z.string().min(1),
  /** The hub's own id for the repo in that space. */
  hubProjectId: z.string().min(1),
});
export type HubLink = z.infer<typeof hubLinkSchema>;

/** A lane its person chose to share with the linked space, at status (phase 1). */
export const hubShareSchema = z.object({
  sessionId: sessionIdSchema,
  spaceId: z.string().min(1),
});
export type HubShare = z.infer<typeof hubShareSchema>;

export const hubStateSchema = z.object({
  connection: hubConnectionSchema,
  /** The hub's web address, for "Open the hub". */
  webUrl: z.string(),
  links: z.array(hubLinkSchema),
  shares: z.array(hubShareSchema),
});
export type HubState = z.infer<typeof hubStateSchema>;

export const HUB_OFF: HubState = {
  connection: { kind: 'signed-out', error: null },
  webUrl: '',
  links: [],
  shares: [],
};

/** The space a project is linked to, when the person is still in it. */
export const hubSpaceOf = (hub: HubState, projectId: string): HubSpace | null => {
  if (hub.connection.kind !== 'signed-in') return null;
  const link = hub.links.find((l) => l.projectId === projectId);
  if (link === undefined) return null;
  return hub.connection.spaces.find((s) => s.id === link.spaceId) ?? null;
};

export const isLaneShared = (hub: HubState, sessionId: string): boolean =>
  hub.shares.some((s) => s.sessionId === sessionId);
