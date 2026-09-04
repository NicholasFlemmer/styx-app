import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Broker endpoint: short Unix socket path (sun_path limit) on POSIX, named pipe on Windows. */
export function brokerEndpoint(opts: { platform: NodeJS.Platform; uid: number; username: string; userData: string; tmpdir?: string }): string {
  if (opts.platform === 'win32') {
    const h = createHash('sha1').update(opts.userData).digest('hex').slice(0, 8);
    return `\\\\.\\pipe\\styx-${opts.username.replace(/[^A-Za-z0-9]/g, '_')}-${h}`;
  }
  return join(opts.tmpdir ?? '/tmp', `styx-${opts.uid}`, 'broker.sock');
}
