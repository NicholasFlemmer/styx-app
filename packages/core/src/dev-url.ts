/**
 * The design window shows local servers only. A `dev.url` can come from a committed `.styx/project.json`, so
 * without this rule a cloned repo could point the window at a remote page framed as the local app.
 *
 * Accepts `localhost`, `127.0.0.1`, `[::1]` (and what the URL parser normalises to them) over http(s), with or
 * without a scheme (`localhost:3000` is what people type). Rejects userinfo, other hosts, other schemes.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const normaliseDevUrl = (text: string): string => {
  const t = text.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
};

export const isLocalDevUrl = (text: string): boolean => {
  try {
    const u = new URL(normaliseDevUrl(text));
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      u.username === '' &&
      u.password === '' &&
      LOCAL_HOSTS.has(u.hostname)
    );
  } catch {
    return false;
  }
};
