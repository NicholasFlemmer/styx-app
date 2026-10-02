import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { logger } from './logger';

const DIST = 'https://nodejs.org/dist';

const indexSchema = z.array(
  z.object({ version: z.string(), lts: z.union([z.string(), z.boolean()]) }).passthrough(),
);

export interface NodeToolDeps {
  /** `<userData>/tools`: Styx's own folder; nothing here is shared with the person's Node. */
  toolsDir: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch: typeof fetch;
  /** Unpacks an archive into a folder (`tar`, which reads .zip too on Windows 10+); injectable for tests. */
  extract?: (archive: string, into: string) => Promise<void>;
}

/** The archive nodejs.org publishes for this machine, or null when there is none Styx knows how to unpack. */
export const nodeArchiveName = (version: string, platform: NodeJS.Platform, arch: string): string | null => {
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (cpu === null) return null;
  if (platform === 'darwin') return `node-${version}-darwin-${cpu}.tar.gz`;
  if (platform === 'linux') return `node-${version}-linux-${cpu}.tar.gz`;
  if (platform === 'win32') return `node-${version}-win-${cpu}.zip`;
  return null;
};

/**
 * A private Node.js for agents that need one (Gemini CLI is an npm package; owner request: "Styx installs what it
 * needs"). Downloaded from nodejs.org, the archive checked against the release's SHASUMS256.txt, and unpacked into
 * Styx's tools folder: no administrator prompt, no change to the person's own Node, nothing on the system PATH.
 * The agent environment gets `binDir` and `npmBinDir` appended to its PATH (PtyService.addPathDirs), so an
 * npm-installed CLI finds `node` and is found itself.
 */
export class NodeToolService {
  constructor(private readonly deps: NodeToolDeps) {}

  private get nodeDir(): string {
    return join(this.deps.toolsDir, 'node');
  }

  /** Where `node` and `npm` are once installed. */
  get binDir(): string {
    return this.deps.platform === 'win32' ? this.nodeDir : join(this.nodeDir, 'bin');
  }

  /** npm's global prefix for what Styx installs (`npm install -g --prefix`), and where those commands land. */
  get prefixDir(): string {
    return join(this.deps.toolsDir, 'npm');
  }

  get npmBinDir(): string {
    return this.deps.platform === 'win32' ? this.prefixDir : join(this.prefixDir, 'bin');
  }

  get npm(): string {
    return join(this.binDir, this.deps.platform === 'win32' ? 'npm.cmd' : 'npm');
  }

  installed(): boolean {
    return existsSync(join(this.binDir, this.deps.platform === 'win32' ? 'node.exe' : 'node'));
  }

  /** Downloads and unpacks the current LTS when it is not there yet; resolves with the bin folder. */
  async ensure(): Promise<string> {
    if (this.installed()) return this.binDir;
    const { fetch: get, platform, arch } = this.deps;
    const index = indexSchema.parse(await (await get(`${DIST}/index.json`)).json());
    const lts = index.find((r) => r.lts !== false);
    if (lts === undefined) throw new Error('nodejs.org lists no LTS release');
    const file = nodeArchiveName(lts.version, platform, arch);
    if (file === null) throw new Error(`no Node.js build for ${platform}-${arch}`);
    const sums = await (await get(`${DIST}/${lts.version}/SHASUMS256.txt`)).text();
    const expected = sums
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find(([, name]) => name === file)?.[0];
    if (expected === undefined) throw new Error(`${file} is not in the release checksums`);
    const res = await get(`${DIST}/${lts.version}/${file}`);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error('the download does not match its published checksum');
    mkdirSync(this.deps.toolsDir, { recursive: true });
    const archive = join(this.deps.toolsDir, file);
    const staging = join(this.deps.toolsDir, 'node-staging');
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    await writeFile(archive, bytes);
    try {
      await (this.deps.extract ?? extractWithTar)(archive, staging);
      const top = readdirSync(staging).find((d) => d.startsWith('node-'));
      if (top === undefined) throw new Error('the archive did not unpack as expected');
      rmSync(this.nodeDir, { recursive: true, force: true });
      renameSync(join(staging, top), this.nodeDir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
      rmSync(archive, { force: true });
    }
    logger.info('node: private Node.js installed', { version: lts.version, dir: this.nodeDir });
    return this.binDir;
  }
}

const extractWithTar = async (archive: string, into: string): Promise<void> => {
  // macOS / Linux tar and Windows' bsdtar (System32) all read .tar.gz; bsdtar reads .zip as well.
  await execa(
    'tar',
    archive.endsWith('.zip') ? ['-xf', archive, '-C', into] : ['-xzf', archive, '-C', into],
    {
      windowsHide: true,
    },
  );
};

/** For tests: the checksum line nodejs.org would publish for some bytes. */
export const shaLine = async (path: string, name: string): Promise<string> =>
  `${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}  ${name}`;
