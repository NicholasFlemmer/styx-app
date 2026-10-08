import { BrokerClient } from '@styx/broker';

/** `styx hook <agent>`: forwards an agent CLI lifecycle hook (JSON on stdin) to the broker. Always exits 0 so it never blocks the agent. */
export async function hook(
  agent: string,
  stdin: NodeJS.ReadableStream,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let raw = '';
  for await (const chunk of stdin) raw += String(chunk);
  let payload: unknown = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }
  const event =
    (payload as { hook_event_name?: string; event?: string }).hook_event_name ??
    (payload as { event?: string }).event ??
    'unknown';
  try {
    const client = BrokerClient.fromEnv('hook', env);
    await client.connect();
    const a =
      (['claude', 'codex', 'gemini', 'cursor', 'opencode', 'shell'] as const).find((x) => x === agent) ??
      'shell';
    await client.call('hook', { agent: a, event, payload }, { timeoutMs: 5000 });
    client.close();
  } catch {
    /* hooks are best effort */
  }
  return 0;
}
