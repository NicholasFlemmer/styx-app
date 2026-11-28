import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

/**
 * Collecting and uploading what a person (the Share sheet) or an agent (`hub_share`) shares to the team hub
 * (ADR-0032 phase 2). The hub hands out one signed upload URL per file; bytes go straight to storage from here.
 */

/** The hub's own limits, checked here first so a share fails before it starts uploading. */
export const SHARE_LIMITS = { fileBytes: 2 * 1024 ** 3, files: 2000, itemBytes: 4 * 1024 ** 3 };

/** Folders that are never part of what someone means to share. */
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', '.styx', '.next', '.turbo', '.cache']);

export interface ShareFile {
  /** Where it sits in the item: relative, forward slashes. */
  path: string;
  abs: string;
  size: number;
  contentType: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
};

export const contentTypeOf = (path: string): string =>
  TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

export class ShareError extends Error {}

const walk = async (dir: string, root: string, out: ShareFile[]): Promise<void> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, root, out);
    else if (entry.isFile()) {
      out.push({
        path: relative(root, abs).split(sep).join('/'),
        abs,
        size: (await stat(abs)).size,
        contentType: contentTypeOf(abs),
      });
      if (out.length > SHARE_LIMITS.files)
        throw new ShareError(`More than ${SHARE_LIMITS.files} files. Share a smaller folder.`);
    }
  }
};

/**
 * The files of a pick. One folder: its contents, relative to it (so a build's `index.html` sits at the root and opens
 * as a site). Anything else: each file by name, each folder under its own name.
 */
export const collect = async (paths: readonly string[]): Promise<ShareFile[]> => {
  const out: ShareFile[] = [];
  for (const p of paths)
    if ((await lstat(p)).isSymbolicLink())
      throw new ShareError(`${basename(p)} is a link; choose the real file.`);
  const only = paths.length === 1 ? paths[0] : undefined;
  if (only !== undefined && (await stat(only)).isDirectory()) await walk(only, only, out);
  else
    for (const p of paths) {
      const st = await stat(p);
      if (st.isDirectory()) await walk(p, join(p, '..'), out);
      else out.push({ path: basename(p), abs: p, size: st.size, contentType: contentTypeOf(p) });
    }
  // Two picked files with one name would overwrite each other in the item: number the later ones.
  const seen = new Set<string>();
  for (const f of out) {
    let path = f.path;
    for (let n = 2; seen.has(path); n += 1) path = f.path.replace(/(\.[^./]*)?$/, (ext) => ` (${n})${ext}`);
    seen.add(path);
    f.path = path;
  }
  if (out.length === 0) throw new ShareError('There is nothing to share in that folder.');
  const big = out.find((f) => f.size > SHARE_LIMITS.fileBytes);
  if (big !== undefined) throw new ShareError(`${big.path} is larger than 2 GB.`);
  if (out.reduce((n, f) => n + f.size, 0) > SHARE_LIMITS.itemBytes)
    throw new ShareError('That is more than 4 GB in one share.');
  return out;
};

/**
 * Paths an agent named, held inside its worktree: anything outside is refused, never shared. Checked on the real path
 * on disk, and a symlink is refused outright, so `ln -s ~/.ssh keys` then `hub_share(["keys"])` cannot reach out.
 */
export const insideWorktree = async (worktree: string, rels: readonly string[]): Promise<string[]> => {
  const root = await realpath(resolve(worktree));
  const out: string[] = [];
  for (const r of rels) {
    const abs = isAbsolute(r) ? resolve(r) : resolve(root, r);
    if (abs !== root && !abs.startsWith(root + sep)) throw new ShareError(`${r} is outside this lane's worktree.`);
    let st;
    try {
      st = await lstat(abs);
    } catch {
      throw new ShareError(`${r} does not exist in this lane's worktree.`);
    }
    if (st.isSymbolicLink()) throw new ShareError(`${r} is a link; share the real file instead.`);
    const real = await realpath(abs);
    if (real !== root && !real.startsWith(root + sep))
      throw new ShareError(`${r} is outside this lane's worktree.`);
    out.push(real);
  }
  return out;
};

/** What the Share sheet lists for a pick: one row per thing picked. */
export const summarise = (paths: readonly string[], files: readonly ShareFile[]) =>
  paths.length === 1
    ? [{ name: basename(paths[0] ?? ''), files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) }]
    : paths.map((p) => {
        const name = basename(p);
        const mine = files.filter((f) => f.path === name || f.path.startsWith(`${name}/`));
        return { name, files: mine.length, bytes: mine.reduce((n, f) => n + f.size, 0) };
      });

/** PUTs one file to its signed URL, reporting bytes as they go. */
export const upload = async (
  fetchImpl: typeof fetch,
  file: ShareFile,
  target: { url: string; headers?: Record<string, string> },
  onBytes: (n: number) => void,
): Promise<void> => {
  // Never follow a link swapped in after collecting, and send exactly what was declared.
  const handle = await open(file.abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  if ((await handle.stat()).size !== file.size) {
    await handle.close();
    throw new ShareError(`${file.path} changed while it was being shared. Share it again.`);
  }
  // The handle's own stream: it closes the file when done, so nothing is closed twice.
  const stream = handle.createReadStream();
  stream.on('data', (chunk) => onBytes(chunk.length));
  const r = await fetchImpl(target.url, {
    method: 'PUT',
    headers: {
      'Content-Type': file.contentType,
      'Content-Length': String(file.size),
      ...(target.headers ?? {}),
    },
    body: Readable.toWeb(stream) as ReadableStream,
    // Node's fetch streams a request body only in half-duplex mode.
    ...({ duplex: 'half' } as object),
  });
  if (!r.ok) throw new ShareError(`Uploading ${file.path} failed (${r.status}).`);
};
