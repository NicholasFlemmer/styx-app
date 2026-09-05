import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Broker endpoint: short Unix socket path (sun_path limit) on POSIX, named pipe on Windows. The pipe name is
 * otherwise guessable (username + userData hash), so `secret` — random, persisted per user in userData — makes it
 * unpredictable to other local users (L2).
 */
export function brokerEndpoint(opts: { platform: NodeJS.Platform; uid: number; username: string; userData: string; tmpdir?: string; secret?: string }): string {
  if (opts.platform === 'win32') {
    const h = createHash('sha1').update(opts.userData).digest('hex').slice(0, 8);
    const suffix = opts.secret ? `-${opts.secret.replace(/[^A-Za-z0-9]/g, '')}` : '';
    return `\\\\.\\pipe\\styx-${opts.username.replace(/[^A-Za-z0-9]/g, '_')}-${h}${suffix}`;
  }
  return join(opts.tmpdir ?? '/tmp', `styx-${opts.uid}`, 'broker.sock');
}
