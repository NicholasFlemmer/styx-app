import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrokerClient } from './client';
import { createStyxMcpServer } from './mcp-stdio';
import { BrokerServer } from './server';

const TOKEN = 't'.repeat(32);
let server: BrokerServer;
afterEach(async () => server?.close());

describe('styx MCP server', () => {
  it('exposes the six tools and proxies calls to the broker', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'styx-mcp-')), 'b.sock');
    server = new BrokerServer({
      authenticate: async () => ({ sessionId: 's1', projectId: 'p', projectName: 'acme-shop', worktreePath: null, branch: null, agent: 'claude' }),
    });
    server.on('list_targets', async () => [{ name: 'Supabase', provider: 'supabase', env: 'prod', lockState: 'locked', scopes: ['read', 'write'] }]);
    server.on('request_access', async (p) => ({ status: 'active', grantId: 'g1', scope: p.scope, expiresAt: null, decidedBy: 'policy' }));
    await server.listen(path);

    const broker = new BrokerClient({ endpoint: path, sessionId: 's1', token: TOKEN, client: 'mcp', pid: 1 });
    await broker.connect();
    const mcp = createStyxMcpServer(broker);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.connect(st);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(ct);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['ask_user', 'check_grant', 'get_credential', 'list_targets', 'report_status', 'request_access']);

    const lt = await client.callTool({ name: 'list_targets', arguments: {} });
    expect(JSON.parse((lt.content as { text: string }[])[0]?.text ?? '')).toEqual([{ name: 'Supabase', provider: 'supabase', env: 'prod', lockState: 'locked', scopes: ['read', 'write'] }]);

    const ra = await client.callTool({ name: 'request_access', arguments: { target: 'supabase-prod', scope: ['read'], reason: 'list tables' } });
    expect(JSON.parse((ra.content as { text: string }[])[0]?.text ?? '')).toMatchObject({ status: 'active', grantId: 'g1' });

    const bad = await client.callTool({ name: 'get_credential', arguments: { grantId: 'nope' } });
    expect(bad.isError).toBe(true);
    broker.close();
    await client.close();
  });
});
