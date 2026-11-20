import type { Socket } from 'node:net';

/** Splits a socket stream into newline-delimited JSON messages. */
export function onNdjson(
  socket: Socket,
  handler: (msg: unknown, raw: string) => void,
  onBad?: (raw: string) => void,
): void {
  // Linear in what arrives: a chunk is searched once, and an unfinished line is joined once when it ends.
  let parts: string[] = [];
  let pending = 0;
  const take = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      handler(JSON.parse(trimmed), trimmed);
    } catch {
      onBad?.(trimmed);
    }
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    let start = 0;
    let nl = chunk.indexOf('\n');
    while (nl >= 0) {
      const piece = chunk.slice(start, nl);
      if (parts.length > 0) {
        parts.push(piece);
        const line = parts.join('');
        parts = [];
        pending = 0;
        take(line);
      } else take(piece);
      start = nl + 1;
      nl = chunk.indexOf('\n', start);
    }
    if (start < chunk.length) {
      parts.push(chunk.slice(start));
      pending += chunk.length - start;
      // No message is this big: a peer that never ends its line is cut off rather than filling memory.
      if (pending > MAX_LINE) {
        parts = [];
        pending = 0;
        onBad?.('(message too long)');
        socket.destroy();
      }
    }
  });
}

/** The longest message a connection may send (16 MB). */
export const MAX_LINE = 16 * 1024 * 1024;

export function writeNdjson(socket: Socket, msg: unknown): void {
  if (!socket.destroyed) socket.write(JSON.stringify(msg) + '\n');
}
