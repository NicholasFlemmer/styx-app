/**
 * The Mac update feed that every installed Styx reads. The Download section shows the version it serves, so a
 * published release updates the site without a redeploy (the build-time version is the fallback).
 */
export const FEED_URL = 'https://storage.googleapis.com/styx-desktop-releases/mac/latest-mac.yml';

/** The `version:` line of an electron-builder feed file, if it is a plain version number. */
export const parseFeedVersion = (text: string): string | null => {
  const m = /^version:\s*['"]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)['"]?\s*$/m.exec(text);
  return m?.[1] ?? null;
};
