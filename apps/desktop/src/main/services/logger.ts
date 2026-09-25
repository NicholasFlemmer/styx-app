import log from 'electron-log/main';

const SECRET_KEYS =
  /(token|secret|password|passphrase|private[_-]?key|authorization|cookie|session_token|access_key)/i;
/**
 * Names of `NAME=value` tokens on a command line that carry a secret: the object-key rule plus `API_KEY`,
 * `STRIPE_KEY`, … (a bare property called `key` is not a secret, so this is not folded into `SECRET_KEYS`).
 */
const SECRET_ENV_KEYS =
  /(token|secret|password|passphrase|private[_-]?key|authorization|cookie|access_key|api[_-]?key|[_-]key$)/i;
/** `scheme://user:password@host` — a connection string with credentials (`DATABASE_URL=postgres://u:p@…`). */
const URL_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i;
const URL_USERINFO_ANYWHERE = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i;
const SECRET_SHAPES = [
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9-]{20,}/g,
  /sk_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /sbp_[A-Za-z0-9]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /xox[bpsa]-[0-9A-Za-z-]+/g,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
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

/**
 * CLI flags whose *next* argument (or `=value`) is a secret. `-p` covers `--password` short forms (ssh's port is
 * collateral); `--body`/`-b`/`--value` carry `gh secret set` / `vercel env add` payloads (PR bodies are collateral).
 */
/** A bare TCP port, the one `-p` value that is never a password. */
const PORT = /^\d{1,5}$/;
const SECRET_FLAGS =
  /^(--token|--with-token|--password|--passphrase|--secret[a-z-]*|--api-key|--body|--value|-p|-b)$/i;
/**
 * Compound identifiers that name a secret and take the next token as its value (`aws configure set
 * aws_secret_access_key X`, `--set api-token X`). Bare `secret`/`token` are subcommands (`gh secret set`) and stay.
 */
const SECRET_WORD =
  /^(?:[a-z0-9.]+[_-])+(?:token|secret|password|passphrase|access_key|access-key|private_key|private-key)(?:[_-][a-z0-9.]+)*$|^(?:token|secret|password|passphrase)(?:[_-][a-z0-9.]+)+$/i;
const SECRET_KV = /^(--?[a-z][a-z0-9_.-]*|[A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/s;

/**
 * Redacts argv before it is persisted (grants.reason, grant_uses.command, audit triggered_by, transcript rows):
 * values following secret flags are dropped, `key=value` with a secret key is masked, then `redact()` runs over
 * each token for secret-shaped values.
 */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let dropNext = false;
  for (const [i, a] of argv.entries()) {
    if (dropNext) {
      out.push('[redacted]');
      dropNext = false;
      continue;
    }
    // `-p` is `--password` for mysql and friends and `--port` for ssh, next, vite…: a value that is nothing but a
    // port number is a port. (A run command with `-- -p 3010` was refused as secret-bearing, and never remembered.)
    if (/^-p$/i.test(a) && PORT.test(argv[i + 1] ?? '')) {
      out.push(a);
      continue;
    }
    if (SECRET_FLAGS.test(a) || SECRET_WORD.test(a)) {
      out.push(a);
      dropNext = true;
      continue;
    }
    const kv = SECRET_KV.exec(a);
    if (kv?.[1] !== undefined && (SECRET_FLAGS.test(kv[1]) || SECRET_ENV_KEYS.test(kv[1]))) {
      out.push(`${kv[1]}=[redacted]`);
      continue;
    }
    if (kv?.[2] !== undefined) {
      // `--set-env-vars=DB_PASSWORD=x`, `-e TOKEN=x`: a secret key one level down.
      const inner = SECRET_KV.exec(kv[2]);
      if (
        URL_USERINFO.test(kv[2]) ||
        (inner?.[1] !== undefined && (SECRET_FLAGS.test(inner[1]) || SECRET_ENV_KEYS.test(inner[1])))
      ) {
        out.push(`${kv[1]}=[redacted]`);
        continue;
      }
    }
    if (URL_USERINFO.test(a)) {
      out.push('[redacted]');
      continue;
    }
    out.push(redact(a));
  }
  return out;
}

/**
 * Whether a command line Styx is asked to keep (a run or deploy command an agent or the user hands over) carries
 * anything `redactArgv` would mask. Such a command is refused rather than stored: it would land in the committed
 * `.styx/project.json` or the target row, and be echoed in transcripts and audit rows. Compared token by token,
 * so spacing never counts as a difference.
 */
/** The secret-file rule lives in core (the composer refuses such a file before it is read); re-exported here. */
export { isSecretFile } from '@styx/core';

/**
 * Masks secret-bearing lines in a unified diff before it leaves for a drafting model: `KEY=value` lines whose key
 * names a secret, and connection strings with credentials, on top of the token shapes `redact()` knows.
 */
export function redactPatch(patch: string): string {
  return redact(patch)
    .split('\n')
    .map((line) => {
      const m = /^([+-]\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/.exec(line);
      if (
        m?.[2] !== undefined &&
        m[3] !== undefined &&
        (SECRET_ENV_KEYS.test(m[2]) || SECRET_FLAGS.test(m[2]) || URL_USERINFO_ANYWHERE.test(m[3]))
      )
        return `${m[1]}${m[2]}=[redacted]`;
      if (/^[+-]/.test(line) && URL_USERINFO_ANYWHERE.test(line)) return `${line.slice(0, 1)} [redacted]`;
      return line;
    })
    .join('\n');
}

export function commandCarriesSecret(command: string): boolean {
  const tokens = command.split(/\s+/).filter((t) => t !== '');
  const masked = redactArgv(tokens);
  return masked.some((t, i) => t !== tokens[i]);
}

/** Every log line passes through `redact()`: the message too, since callers interpolate error text into it (L-b). */
export const logger = {
  info: (msg: string, meta?: unknown) => log.info(redact(msg), meta === undefined ? '' : redact(meta)),
  warn: (msg: string, meta?: unknown) => log.warn(redact(msg), meta === undefined ? '' : redact(meta)),
  error: (msg: string, meta?: unknown) => log.error(redact(msg), meta === undefined ? '' : redact(meta)),
  debug: (msg: string, meta?: unknown) => log.debug(redact(msg), meta === undefined ? '' : redact(meta)),
};
