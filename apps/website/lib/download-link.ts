/** The platforms there is a build for. Linux (beta) has no counting route; its builds are on GitHub Releases. */
export type DownloadPlatform = 'mac' | 'win' | 'linux';

/**
 * What a link does about downloading, from its href alone: fetches a build (`file`, with its platform), jumps
 * to the Download section where the visitor then picks one (`section`), or neither (`null`). Only `file` is a
 * download; counting the section jump as one double-counted every download that started from a nav or hero
 * button, and every visitor who looked and left.
 */
export type DownloadLink = { kind: 'file'; platform: DownloadPlatform } | { kind: 'section' } | null;

export const classifyDownloadLink = (href: string): DownloadLink => {
  const h = href.trim().toLowerCase();
  if (!h) return null;
  // /download/mac and /download/win count the download and redirect (deploy/nginx.conf); bare /download is Mac.
  const route = /\/download(?:\/(mac|win))?\/?(?:[?#]|$)/.exec(h);
  if (route) return { kind: 'file', platform: route[1] === 'win' ? 'win' : 'mac' };
  if (/\.dmg(?:[?#]|$)/.test(h)) return { kind: 'file', platform: 'mac' };
  if (/\.(?:exe|msi|msix|appx)(?:[?#]|$)/.test(h)) return { kind: 'file', platform: 'win' };
  if (/\.(?:appimage|deb)(?:[?#]|$)/.test(h)) return { kind: 'file', platform: 'linux' };
  // The Linux card links to the latest GitHub release page, where the AppImage and .deb are: the site's only
  // link there, so it is the Linux download. A link to the repository itself is not.
  if (/github\.com\/nicholasflemmer\/styx-app\/releases(?:\/latest)?\/?(?:[?#]|$)/.test(h))
    return { kind: 'file', platform: 'linux' };
  if (/#download$/.test(h)) return { kind: 'section' };
  return null;
};
