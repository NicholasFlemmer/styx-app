import type { Socket } from 'node:net';

/** Splits a socket stream into newline-delimited JSON messages. */
export function onNdjson(socket: Socket, handler: (msg: unknown, raw: string) => void, onBad?: (raw: string) => void): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        handler(JSON.parse(line), line);
      } catch {
        onBad?.(line);
      }
    }
  });
}

export function writeNdjson(socket: Socket, msg: unknown): void {
  if (!socket.destroyed) socket.write(JSON.stringify(msg) + '\n');
}
