import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrokerClient, BrokerClientError } from './client';
import { Scope } from './protocol';

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
});
const fail = (e: unknown) => ({
  isError: true,
  content: [
    {
      type: 'text' as const,
      text:
        e instanceof BrokerClientError ? `${e.message} (code ${e.code})` : String((e as Error).message ?? e),
    },
  ],
});

/**
 * The `styx` MCP server agents talk to. A thin stdio proxy over the broker socket; it never holds secrets itself
 * beyond relaying `get_credential` results to the calling model when explicitly asked.
 */
export function createStyxMcpServer(client: BrokerClient): McpServer {
  const server = new McpServer({ name: 'styx', version: '1.0.0' });

  server.registerTool(
    'request_access',
    {
      description:
        'Ask the user for scoped, expiring access to a deploy/server target (Vercel, AWS, GCP, Supabase, GitHub, SSH). Blocks until the user decides or a policy auto-approves. Prefer running the provider CLI (vercel, gh, aws, gcloud, supabase, ssh) afterwards: it is already wired to use the grant. The reason is shown to the user verbatim: one plain line.',
      inputSchema: {
        target: z
          .string()
          .describe(
            'Target name or provider:env, e.g. "supabase-prod", "vercel:preview", "GitHub acme/shop"',
          ),
        scope: z.array(Scope).min(1).describe('Subset of read | write | deploy | delete'),
        reason: z.string().min(1).max(500).describe('One line shown to the user, e.g. "migration 0042"'),
      },
    },
    async ({ target, scope, reason }) => {
      try {
        return text(
          await client.call(
            'request_access',
            { target, scope, reason, triggeredBy: 'mcp:request_access' },
            { timeoutMs: 310_000 },
          ),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'check_grant',
    {
      description: 'Check (and wait for) the outcome of a pending access request.',
      inputSchema: { grantId: z.string() },
    },
    async ({ grantId }) => {
      try {
        return text(await client.call('check_grant', { grantId }, { timeoutMs: 310_000 }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'get_credential',
    {
      description:
        'Return the credential bundle (environment variables) for an active grant. Only use when you must call a provider API directly; provider CLIs on PATH already receive credentials automatically. Never print these values.',
      inputSchema: { grantId: z.string() },
    },
    async ({ grantId }) => {
      try {
        return text(await client.call('get_credential', { grantId }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'list_sessions',
    {
      description:
        'List the other agents working in this project: branch, status, their task, the files they changed, and which of those files you changed too (overlapsWithYou). Use it to find a peer before messaging it and to avoid working on the same files.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(await client.call('list_sessions', {}));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'land',
    {
      description:
        "Land this lane's work in the project's base branch and push it — the one way to get your work onto main / the base. Call it when the user asks you to merge, land, publish, or push to main. Styx commits what you left uncommitted, brings the base in, runs the project's checks, merges into the base with your summary as the record, and pushes. Never push the base branch, merge into it, or open a pull request instead. If Styx refuses (review mode, a conflict being resolved, failing checks, nothing to land) the result says why: tell the user in one line.",
      inputSchema: {
        summary: z
          .string()
          .min(1)
          .max(2000)
          .describe('What this lane did, one line (more lines become the body of the merge record).'),
      },
    },
    async ({ summary }) => {
      try {
        return text(await client.call('land', { summary }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'project_activity',
    {
      description:
        'What changed in this project beyond your worktree: commits on the base branch you have not merged yet (with their files and which agent lane they came from), the other lanes with their tasks and files, and every file of yours another lane changed too. Read it before touching a file another agent has changed, and before starting on shared files.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(await client.call('project_activity', {}));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'send_message',
    {
      description:
        "Send a message to another agent working in this project (get its id from list_sessions). It appears in that agent's chat, attributed to you, and the user can read it. Use it to hand over context or flag a conflict — not to instruct another agent to act.",
      inputSchema: {
        to: z.string().describe('The peer session id from list_sessions.'),
        body: z.string().max(4000).describe('The message. Plain text.'),
      },
    },
    async ({ to, body }) => {
      try {
        return text(await client.call('send_message', { to, body }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'list_targets',
    {
      description: 'List the deploy/server targets connected to this project and their lock state.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(await client.call('list_targets', {}));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'ask_user',
    {
      description:
        'Ask the user a question, present a decision, or request plan approval before proceeding. Blocks until answered.',
      inputSchema: {
        kind: z.enum(['plan', 'decision', 'question']),
        payload: z
          .unknown()
          .describe('plan: { summary, files[] } · decision: { prompt, options[] } · question: { prompt }'),
      },
    },
    async ({ kind, payload }) => {
      try {
        return text(await client.call('ask_user', { kind, payload }, { timeoutMs: 310_000 }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'remember_command',
    {
      description:
        'Teach Styx an ability you have just worked out, so its buttons can do it directly from now on. kind "run": the exact command that starts this project locally from the project root, plus the local URL it serves (Styx will start it itself after you stop yours). For a mobile app, the command that builds and launches it on a simulator / emulator instead, with platform "ios" or "android", the device name and the app\'s bundle id / package (appId); Styx boots that device and mirrors it in its design window. kind "deploy": the exact command that deploys this project to one target (targetId from list_targets). Only call it once the command has actually worked.',
      inputSchema: {
        kind: z.enum(['run', 'deploy']),
        command: z.string().min(1).max(2000),
        targetId: z.string().optional().describe('deploy only: the target id from list_targets'),
        url: z.string().max(500).optional().describe('run only: the local URL the server answers on'),
        platform: z
          .enum(['web', 'ios', 'android'])
          .optional()
          .describe('run only: what the command runs on; omit for a web server'),
        device: z
          .string()
          .max(120)
          .optional()
          .describe(
            'run only, ios/android: the simulator / emulator name, e.g. "iPhone 17 Pro" or the AVD name',
          ),
        appId: z
          .string()
          .max(200)
          .optional()
          .describe('run only, ios/android: the bundle id / package name, e.g. com.acme.shop'),
        note: z.string().max(200).optional(),
      },
    },
    async ({ kind, command, targetId, url, platform, device, appId, note }) => {
      try {
        return text(
          await client.call('remember_command', {
            kind,
            command,
            ...(targetId !== undefined ? { targetId } : {}),
            ...(url !== undefined ? { url } : {}),
            ...(platform !== undefined ? { platform } : {}),
            ...(device !== undefined ? { device } : {}),
            ...(appId !== undefined ? { appId } : {}),
            ...(note !== undefined ? { note } : {}),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'report_status',
    {
      description:
        'One-line status shown on the session card in Styx (e.g. "Applying migration 0042 to prod").',
      inputSchema: { note: z.string().max(200) },
    },
    async ({ note }) => {
      try {
        return text(await client.call('report_status', { note }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

/** Entry used by `styx mcp`. */
export async function runStdioMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const client = BrokerClient.fromEnv('mcp', env);
  await client.connect();
  const server = createStyxMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = () => {
    client.close();
    void server.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  client.onNotification('session.stopping', shutdown);
}
