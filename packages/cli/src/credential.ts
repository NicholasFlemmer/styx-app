import { BrokerClient, GIT_CREDENTIAL_TOOL, githubRepository } from '@styx/broker';

interface CredentialIo {
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function credential(action: string | undefined, io: CredentialIo): Promise<number> {
  if (action === 'store' || action === 'erase') return 0;
  let client: BrokerClient | null = null;
  try {
    if (action !== 'get') throw new Error('unsupported credential action');
    let raw = '';
    for await (const chunk of io.stdin) {
      raw += String(chunk);
      if (raw.length > 16_384) throw new Error('credential request is too large');
    }
    const fields = new Map<string, string>();
    for (const line of raw.split(/\r?\n/)) {
      if (line === '') break;
      const at = line.indexOf('=');
      if (at < 1) throw new Error('invalid credential request');
      const key = line.slice(0, at);
      if (fields.has(key) || key === 'url') throw new Error('ambiguous credential request');
      fields.set(key, line.slice(at + 1));
    }
    const repository = githubRepository((fields.get('path') ?? '').replace(/\.git$/, ''));
    if (
      fields.get('protocol') !== 'https' ||
      fields.get('host')?.toLowerCase() !== 'github.com' ||
      repository === null
    )
      throw new Error('only HTTPS GitHub repository credentials are supported');
    const operation = io.env['STYX_GIT_OPERATION'] === 'fetch' ? 'fetch' : 'push';
    client = BrokerClient.fromEnv('shim', io.env);
    await client.connect();
    const result = await client.call(
      'exec_authorize',
      {
        tool: GIT_CREDENTIAL_TOOL,
        argv: ['get', operation, `https://github.com/${repository}.git`],
        cwd: process.cwd(),
      },
      { timeoutMs: 600_000 },
    );
    const token = result.env['GH_TOKEN'];
    if (!token || /[\r\n\0]/.test(token)) throw new Error('no valid GitHub credential was issued');
    io.stdout(`username=x-access-token\npassword=${token}\n\n`);
    await client.call('exec_report', { useId: result.useId, exitCode: 0 }).catch(() => undefined);
    return 0;
  } catch {
    io.stdout('quit=true\n\n');
    io.stderr('styx: GitHub credential access was not granted.\n');
    return 1;
  } finally {
    client?.close();
  }
}
