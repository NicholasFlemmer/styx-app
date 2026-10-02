import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NodeToolService, nodeArchiveName } from './node-tool-service';

const ARCHIVE = Buffer.from('pretend this is a node tarball');
const SHA = createHash('sha256').update(ARCHIVE).digest('hex');

/** nodejs.org in miniature: an index with an LTS, its checksums and the archive. */
const site = (sha = SHA) =>
  vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/index.json'))
      return new Response(
        JSON.stringify([
          { version: 'v25.0.0', lts: false },
          { version: 'v24.9.0', lts: 'Krypton' },
        ]),
      );
    if (u.endsWith('/SHASUMS256.txt'))
      return new Response(`${sha}  node-v24.9.0-darwin-arm64.tar.gz\naaaa  node-v24.9.0-linux-x64.tar.gz\n`);
    if (u.endsWith('node-v24.9.0-darwin-arm64.tar.gz')) return new Response(ARCHIVE);
    return new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;

/** Stands in for tar: "unpacks" a node-v… folder with a bin/node in it. */
const fakeExtract = async (_archive: string, into: string) => {
  const dir = join(into, 'node-v24.9.0-darwin-arm64', 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'node'), '');
};

describe('NodeToolService: a private Node.js for agents that need one', () => {
  it('downloads the current LTS, checks it against the published checksum, unpacks it into the tools folder', async () => {
    const toolsDir = mkdtempSync(join(tmpdir(), 'styx-tools-'));
    const svc = new NodeToolService({
      toolsDir,
      platform: 'darwin',
      arch: 'arm64',
      fetch: site(),
      extract: fakeExtract,
    });
    expect(svc.installed()).toBe(false);
    expect(await svc.ensure()).toBe(join(toolsDir, 'node', 'bin'));
    expect(svc.installed()).toBe(true);
    expect(svc.npm).toBe(join(toolsDir, 'node', 'bin', 'npm'));
    expect(svc.npmBinDir).toBe(join(toolsDir, 'npm', 'bin'));
    // Nothing left behind but the node folder; a second ensure downloads nothing.
    expect(readdirSync(toolsDir)).toEqual(['node']);
    const again = site();
    const svc2 = new NodeToolService({ toolsDir, platform: 'darwin', arch: 'arm64', fetch: again });
    await svc2.ensure();
    expect(again).not.toHaveBeenCalled();
  });

  it('refuses a download that does not match its checksum, and leaves nothing installed', async () => {
    const toolsDir = mkdtempSync(join(tmpdir(), 'styx-tools-'));
    const svc = new NodeToolService({
      toolsDir,
      platform: 'darwin',
      arch: 'arm64',
      fetch: site('0'.repeat(64)),
      extract: fakeExtract,
    });
    await expect(svc.ensure()).rejects.toThrow(/does not match its published checksum/);
    expect(existsSync(join(toolsDir, 'node'))).toBe(false);
  });

  it('a machine with no build, or a release missing from the checksums, says so', async () => {
    const toolsDir = mkdtempSync(join(tmpdir(), 'styx-tools-'));
    await expect(
      new NodeToolService({ toolsDir, platform: 'darwin', arch: 'ia32', fetch: site() }).ensure(),
    ).rejects.toThrow(/no Node.js build/);
    await expect(
      new NodeToolService({ toolsDir, platform: 'win32', arch: 'x64', fetch: site() }).ensure(),
    ).rejects.toThrow(/not in the release checksums/);
  });

  it.each([
    ['v24.9.0', 'darwin', 'arm64', 'node-v24.9.0-darwin-arm64.tar.gz'],
    ['v24.9.0', 'darwin', 'x64', 'node-v24.9.0-darwin-x64.tar.gz'],
    ['v24.9.0', 'linux', 'x64', 'node-v24.9.0-linux-x64.tar.gz'],
    ['v24.9.0', 'win32', 'x64', 'node-v24.9.0-win-x64.zip'],
    ['v24.9.0', 'win32', 'arm64', 'node-v24.9.0-win-arm64.zip'],
    ['v24.9.0', 'freebsd', 'x64', null],
    ['v24.9.0', 'linux', 'ppc64', null],
  ] as const)('%s on %s-%s → %s', (version, platform, arch, file) => {
    expect(nodeArchiveName(version, platform, arch)).toBe(file);
  });

  it('on Windows node and npm sit in the folder itself, and npm is npm.cmd', () => {
    const svc = new NodeToolService({ toolsDir: 'C:\\t', platform: 'win32', arch: 'x64', fetch: site() });
    expect(svc.binDir).toBe(join('C:\\t', 'node'));
    expect(svc.npm).toBe(join('C:\\t', 'node', 'npm.cmd'));
    expect(svc.npmBinDir).toBe(join('C:\\t', 'npm'));
  });
});
