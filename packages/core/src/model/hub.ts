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

/** One thing waiting on the person (ADR-0032 round 1): an ask, a mention, a task, an item to review. */
export const hubInboxEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(['ask', 'mention', 'task', 'review']),
  spaceId: z.string(),
  spaceName: z.string(),
  threadId: z.string().nullable(),
  itemId: z.string().nullable(),
  title: z.string(),
  snippet: z.string(),
  who: z.object({ name: z.string().nullable(), agent: z.string().nullable() }),
  at: z.number(),
  read: z.boolean(),
  ask: z.object({ id: z.string(), options: z.array(z.string()).nullable() }).nullable(),
});
export type HubInboxEntry = z.infer<typeof hubInboxEntrySchema>;

/** A thread as the Team screen shows it: where it stands, its tasks, open asks and the conversation. */
export const hubThreadViewSchema = z.object({
  thread: z.object({
    id: z.string(),
    title: z.string(),
    status: z.enum(['open', 'done']),
    owner: z.string().nullable(),
    summary: z.string(),
    spaceName: z.string(),
  }),
  tasks: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      done: z.boolean(),
      assignee: z.string().nullable(),
      mine: z.boolean(),
    }),
  ),
  asks: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      options: z.array(z.string()).nullable(),
      asker: z.string(),
      open: z.boolean(),
      canAnswer: z.boolean(),
      answer: z.string().nullable(),
    }),
  ),
  messages: z.array(
    z.object({
      id: z.string(),
      who: z.string(),
      agent: z.string().nullable(),
      branch: z.string().nullable(),
      body: z.string(),
      at: z.number(),
    }),
  ),
});
export type HubThreadView = z.infer<typeof hubThreadViewSchema>;

/** A room as the Team screen lists it (ADR-0032 round 2): its goal, how far its board is, and the lanes in it. */
export const hubRoomSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  doneWhen: z.string(),
  state: z.enum(['active', 'paused', 'closed']),
  spaceName: z.string(),
  planApproved: z.boolean(),
  tasks: z.object({ done: z.number().int(), total: z.number().int() }),
  lanes: z.array(
    z.object({
      laneId: z.string(),
      agent: z.string(),
      owner: z.string(),
      brings: z.string(),
      mode: z.enum(['wait', 'work']),
      mine: z.boolean(),
    }),
  ),
});
export type HubRoomSummary = z.infer<typeof hubRoomSummarySchema>;

/**
 * The lean hub (ADR-0032, 2026-11-17): a conversation shared as a link anyone can read, and team context, the
 * business's own knowledge that everyone on the team adds to and every agent can use.
 */
export const hubContextEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(['decision', 'doc', 'link']),
  title: z.string(),
  body: z.string(),
  stale: z.boolean(),
  /** Who added it, or the agent and its person. */
  by: z.string(),
  updatedAt: z.number(),
});
export type HubContextEntry = z.infer<typeof hubContextEntrySchema>;

export const hubConversationLinkSchema = z.object({
  id: z.string(),
  url: z.string().nullable(),
  /** The whole conversation, or one answer from it. */
  scope: z.enum(['conversation', 'message']),
  live: z.boolean(),
  opens: z.number().int().nonnegative(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
});
export type HubConversationLink = z.infer<typeof hubConversationLinkSchema>;

export const hubMemberSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  role: z.enum(['admin', 'member']),
});
export type HubMember = z.infer<typeof hubMemberSchema>;

export const hubStateSchema = z.object({
  connection: hubConnectionSchema,
  /** The hub's web address, for "Open the hub". */
  webUrl: z.string(),
  links: z.array(hubLinkSchema),
  shares: z.array(hubShareSchema),
  /** Lanes here that are in a room (ADR-0032 round 2), and whether each waits for its person or works on room tasks. */
  rooms: z
    .array(
      z.object({
        sessionId: z.string(),
        roomId: z.string(),
        title: z.string(),
        mode: z.enum(['wait', 'work']),
      }),
    )
    .default([]),
  /** How many things wait on the person across their spaces (the Team rail tile's count). */
  waiting: z.number().int().nonnegative().default(0),
});
export type HubState = z.infer<typeof hubStateSchema>;

export const HUB_OFF: HubState = {
  connection: { kind: 'signed-out', error: null },
  webUrl: '',
  links: [],
  shares: [],
  rooms: [],
  waiting: 0,
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
