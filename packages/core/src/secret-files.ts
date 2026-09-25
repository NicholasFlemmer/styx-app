/**
 * Files whose whole content is a secret by convention: never shown to a drafting model, never staged by an
 * app-driven commit, never handed to an agent as an attachment (an agent's own `git add` or `cat` is its business;
 * what Styx moves is Styx's). Paths or bare names, either separator.
 */
const SECRET_FILE =
  /(^|[\\/])(\.env(\.[^\\/]*)?|\.npmrc|\.netrc|\.pgpass|credentials\.json|service[-_]?account[^\\/]*\.json|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?)$|\.(pem|key|p12|pfx|jks|keystore)$/i;
const SECRET_FILE_ALLOW = /(^|[\\/])\.env\.(example|sample|template)$/i;

export const isSecretFile = (path: string): boolean =>
  SECRET_FILE.test(path) && !SECRET_FILE_ALLOW.test(path);
