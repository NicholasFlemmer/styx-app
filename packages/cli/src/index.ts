import { BrokerClient, runStdioMcp } from '@styx/broker';
import { hook } from './hook';
import { wrap } from './wrap';

const USAGE = `styx — Styx session CLI
  styx mcp                              run the MCP server (stdio) for the current session
  styx wrap <tool> [args…]              run a provider CLI through the grant broker
  styx hook <agent>                     forward an agent lifecycle hook (JSON on stdin)
  styx request <target> <scope…> [-r reason]   ask the user for access from a shell session
  styx status [note]                    show / set the session's one-line status
  styx targets                          list connected targets and lock state
`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'mcp':
      await runStdioMcp(env);
      return new Promise(() => {}); // stays alive until transport closes
    case 'wrap': {
      const [tool, ...args] = rest;
      if (!tool) return usage();
      return wrap(tool, args, { env, stderr: (s) => process.stderr.write(s) });
    }
    case 'hook':
      return hook(rest[0] ?? 'shell', process.stdin, env);
    case 'request': {
      const r = rest.indexOf('-r');
      const reason = r >= 0 ? rest.slice(r + 1).join(' ') : 'requested from shell';
      const args = r >= 0 ? rest.slice(0, r) : rest;
      const [target, ...scopes] = args;
      if (!target || scopes.length === 0) return usage();
      const c = BrokerClient.fromEnv('cli', env);
      await c.connect();
      const out = await c.call('request_access', { target, scope: scopes as ('read' | 'write' | 'deploy' | 'delete')[], reason, triggeredBy: `$ styx request ${args.join(' ')}` }, { timeoutMs: 600_000 });
      process.stdout.write(JSON.stringify(out) + '\n');
      c.close();
      return out.status === 'active' ? 0 : 1;
    }
    case 'status': {
      const c = BrokerClient.fromEnv('cli', env);
      const s = await c.connect();
      if (rest.length) await c.call('report_status', { note: rest.join(' ') });
      process.stdout.write(`${s.agent} · ${s.projectName} · ${s.branch ?? '—'}\n`);
      c.close();
      return 0;
    }
    case 'targets': {
      const c = BrokerClient.fromEnv('cli', env);
      await c.connect();
      for (const t of await c.call('list_targets', {})) process.stdout.write(`${t.name}\t${t.provider}\t${t.env}\t${t.lockState}\n`);
      c.close();
      return 0;
    }
    default:
      return usage();
  }
}

function usage(): number {
  process.stderr.write(USAGE);
  return 64;
}

if (process.argv[1] && /styx(\.js)?$/.test(process.argv[1]) && !process.env['VITEST']) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`styx: ${(e as Error).message}\n`);
      process.exit(70);
    },
  );
}
