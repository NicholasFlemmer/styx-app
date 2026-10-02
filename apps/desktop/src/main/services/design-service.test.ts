import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DESIGN_TOKENS, DESIGN_DIR, fixtures, type Session } from '@styx/core';
import { describe, expect, it, vi } from 'vitest';
import type { Repos } from '../db/repos';
import { DesignService, ensureDesignTokens, stripScripts } from './design-service';

const design = (over: Partial<Session> = {}): Session => {
  const s = fixtures.demoSessions()[0];
  if (s === undefined) throw new Error('fixture');
  return {
    ...s,
    id: 'design-1' as Session['id'],
    worktreeId: 'wt-d' as Session['worktreeId'],
    kind: 'design',
    ...over,
  };
};

const setup = (sessions: Session[] = [design()]) => {
  const root = mkdtempSync(join(tmpdir(), 'styx-design-'));
  const dir = join(root, DESIGN_DIR);
  mkdirSync(join(dir, 'checkout'), { recursive: true });
  writeFileSync(
    join(dir, 'checkout', 'desktop.html'),
    '<html><body><button id="pay">Pay</button></body></html>',
  );
  writeFileSync(join(dir, 'checkout', 'phone.wire.html'), '<html></html>');
  writeFileSync(join(dir, 'notes.md'), 'not a screen');
  const repos = {
    worktrees: {
      get: (id: string) =>
        id === 'wt-d' ? { id, projectId: 'p', path: root, branch: 'agent/claude-4' } : null,
    },
    sessions: {
      all: () => sessions,
      get: (id: string) => sessions.find((s) => s.id === id) ?? null,
    },
    projects: {
      get: () => ({ id: 'p', path: root }),
      settings: () => ({}),
    },
  } as unknown as Repos;
  const git = {
    commitOwnedPaths: vi.fn(async () => true),
    nextAgentBranch: vi.fn(async () => 'agent/codex-2'),
  };
  const sessionsPort = {
    start: vi.fn(async () => ({ sessionId: 'build-1', worktreeId: 'wt-b' })),
    tell: vi.fn(),
    sendMessage: vi.fn(async () => undefined),
  };
  const transcript = { system: vi.fn() };
  const svc = new DesignService({ repos, git, sessions: sessionsPort as never, transcript });
  return { root, dir, svc, git, sessionsPort, transcript };
};

describe('DesignService (#140)', () => {
  it('lists screens and their sizes and fidelities, ignoring anything that is not a screen', () => {
    const { svc } = setup();
    const list = svc.list('wt-d');
    expect(list.screens.map((s) => [s.slug, s.files.map((f) => `${f.size}:${f.fidelity}`)])).toEqual([
      ['checkout', ['desktop:hi', 'phone:wire']],
    ]);
    expect(list.tokens).toBeNull();
  });

  it('reads a screen with the design’s CSS; refuses paths outside the design', () => {
    const { svc } = setup();
    const r = svc.read('wt-d', 'checkout/desktop.html');
    expect(r.html).toContain('id="pay"');
    expect(r.css).toContain('--color-primary');
    expect(() => svc.read('wt-d', '../../etc/desktop.html')).toThrow();
    expect(() => svc.read('wt-d', 'notes.md')).toThrow();
  });

  it('writes hand edits without scripts or inline handlers', () => {
    const { svc, dir } = setup();
    svc.write(
      'wt-d',
      'checkout/desktop.html',
      '<button onclick="x()">Pay now</button><script>alert(1)</script>',
    );
    const html = readFileSync(join(dir, 'checkout', 'desktop.html'), 'utf8');
    expect(html).toBe('<button>Pay now</button>');
    expect(stripScripts('<img src=x onerror=alert(1)>')).toBe('<img src=x>');
  });

  it('never reads or writes through a link: a linked screen, screen folder or design folder is refused', () => {
    const { svc, dir, root } = setup();
    const outside = mkdtempSync(join(tmpdir(), 'styx-outside-'));
    const target = join(outside, 'victim.txt');
    writeFileSync(target, 'precious');
    symlinkSync(target, join(dir, 'checkout', 'phone.html'));
    expect(() => svc.write('wt-d', 'checkout/phone.html', '<p>x</p>')).toThrow();
    expect(() => svc.read('wt-d', 'checkout/phone.html')).toThrow();
    symlinkSync(outside, join(dir, 'linked'));
    expect(() => svc.write('wt-d', 'linked/desktop.html', '<p>x</p>')).toThrow();
    // A hard link is a second name for someone else's file: refused too.
    linkSync(target, join(dir, 'checkout', 'tablet.html'));
    expect(() => svc.write('wt-d', 'checkout/tablet.html', '<p>x</p>')).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('precious');
    // The design folder itself linked away: tokens are not written there.
    const other = mkdtempSync(join(tmpdir(), 'styx-linked-design-'));
    const r2 = mkdtempSync(join(tmpdir(), 'styx-root2-'));
    mkdirSync(join(r2, '.styx'));
    symlinkSync(other, join(r2, DESIGN_DIR));
    ensureDesignTokens(r2);
    expect(existsSync(join(other, 'tokens.json'))).toBe(false);
    // A dangling tokens link is not created through.
    const r3 = mkdtempSync(join(tmpdir(), 'styx-root3-'));
    mkdirSync(join(r3, DESIGN_DIR), { recursive: true });
    symlinkSync(join(outside, 'planted.css'), join(r3, DESIGN_DIR, 'tokens.css'));
    ensureDesignTokens(r3);
    expect(existsSync(join(outside, 'planted.css'))).toBe(false);
    expect(root).toBeTruthy();
  });

  it('Type and colour writes tokens.json and tokens.css', () => {
    const { svc, dir } = setup();
    svc.setTokens('wt-d', { ...DEFAULT_DESIGN_TOKENS, radius: 12 });
    expect(JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8')).radius).toBe(12);
    expect(readFileSync(join(dir, 'tokens.css'), 'utf8')).toContain('--radius: 12px;');
    expect(svc.list('wt-d').tokens?.radius).toBe(12);
  });

  it('seeds tokens for a new design task, once', () => {
    const root = mkdtempSync(join(tmpdir(), 'styx-design-seed-'));
    ensureDesignTokens(root);
    const json = join(root, DESIGN_DIR, 'tokens.json');
    writeFileSync(json, JSON.stringify({ ...DEFAULT_DESIGN_TOKENS, radius: 3 }));
    ensureDesignTokens(root);
    expect(JSON.parse(readFileSync(json, 'utf8')).radius).toBe(3);
  });

  it('Build it as a new task: commits the design, branches the build from it, links it', async () => {
    const { svc, git, sessionsPort, transcript } = setup();
    const id = await svc.handover({
      sessionId: 'design-1',
      mode: 'new',
      agent: 'codex',
      screens: ['checkout'],
      tokens: true,
      note: 'use our Button',
    });
    expect(id).toBe('build-1');
    expect(git.commitOwnedPaths).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [DESIGN_DIR],
      expect.stringContaining('Checkout'),
    );
    expect(sessionsPort.start).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        worktree: { kind: 'new', base: 'agent/claude-4', branch: 'agent/codex-2' },
        kind: 'build',
        designSessionId: 'design-1',
      }),
    );
    const first = (sessionsPort.start.mock.calls[0] as unknown as [{ firstMessage: string }])[0].firstMessage;
    expect(first).toContain('Checkout');
    expect(first).toContain('tokens.json');
    expect(first).toContain('use our Button');
    expect(transcript.system).toHaveBeenCalled();
  });

  it('Build here sends the handover to the design task itself', async () => {
    const { svc, sessionsPort } = setup();
    expect(
      await svc.handover({
        sessionId: 'design-1',
        mode: 'here',
        agent: 'claude',
        screens: ['checkout'],
        tokens: false,
        note: '',
      }),
    ).toBe('design-1');
    expect(sessionsPort.sendMessage).toHaveBeenCalledWith('design-1', expect.stringContaining('Checkout'));
    expect(sessionsPort.start).not.toHaveBeenCalled();
  });

  it('a changed design tells the build tasks built from it, and nobody when none are', async () => {
    const build = design({
      id: 'build-1' as Session['id'],
      kind: 'build',
      designSessionId: 'design-1' as Session['id'],
      worktreeId: 'wt-b' as Session['worktreeId'],
    });
    const { svc, sessionsPort, transcript } = setup([design(), build]);
    await svc.changed('wt-d', ['checkout/desktop.html']);
    expect(sessionsPort.tell).toHaveBeenCalledWith('build-1', expect.stringContaining('Checkout'));
    expect(transcript.system).toHaveBeenCalledWith('design-1', expect.stringContaining('Checkout'));
    const lone = setup();
    await lone.svc.changed('wt-d', ['checkout/desktop.html']);
    expect(lone.sessionsPort.tell).not.toHaveBeenCalled();
  });
});
