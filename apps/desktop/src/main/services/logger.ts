import log from 'electron-log/main';

const SECRET_KEYS =
  /(token|secret|password|passphrase|private[_-]?key|authorization|cookie|session_token|access_key)/i;
const SECRET_SHAPES = [
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /xox[bp]-[0-9A-Za-z-]+/g,
];

/** Redacts secret-shaped values so nothing sensitive reaches logs, audit detail, or IPC payloads. */
export function redact<T>(value: T): T {
  if (typeof value === 'string') {
    let out: string = value;
    for (const re of SECRET_SHAPES) out = out.replace(re, '[redacted]');
    return out as T;
  }
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v);
    return out as T;
  }
  return value;
}

/** CLI flags whose *next* argument (or `=value`) is a secret. `-p` covers `--password` short forms (ssh's port is collateral). */
const SECRET_FLAGS = /^(--token|--with-token|--password|--passphrase|--secret[a-z-]*|--api-key|-p)$/i;
const SECRET_KV = /^(--?[a-z][a-z0-9-]*)=(.*)$/is;

/**
 * Redacts argv before it is persisted (grants.reason, grant_uses.command, audit triggered_by, transcript rows):
 * values following secret flags are dropped, `key=value` with a secret key is masked, then `redact()` runs over
 * each token for secret-shaped values.
 */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let dropNext = false;
  for (const a of argv) {
    if (dropNext) {
      out.push('[redacted]');
      dropNext = false;
      continue;
    }
    if (SECRET_FLAGS.test(a)) {
      out.push(a);
      dropNext = true;
      continue;
    }
    const kv = SECRET_KV.exec(a);
    if (kv?.[1] !== undefined && (SECRET_FLAGS.test(kv[1]) || SECRET_KEYS.test(kv[1]))) {
      out.push(`${kv[1]}=[redacted]`);
      continue;
    }
    out.push(redact(a));
  }
  return out;
}

export const logger = {
  info: (msg: string, meta?: unknown) => log.info(msg, meta === undefined ? '' : redact(meta)),
  warn: (msg: string, meta?: unknown) => log.warn(msg, meta === undefined ? '' : redact(meta)),
  error: (msg: string, meta?: unknown) => log.error(msg, meta === undefined ? '' : redact(meta)),
  debug: (msg: string, meta?: unknown) => log.debug(msg, meta === undefined ? '' : redact(meta)),
};
