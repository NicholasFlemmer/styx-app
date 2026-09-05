import { fixtures } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { fixtureFileText } from './fixture-files';
import {
  addedLinesOf,
  buildHunkDecorations,
  hunkBarLabel,
  hunkMatchesFile,
  locateHunk,
  newSideOf,
  pendingHunksOf,
} from './hunk-decorations';

const lines = fixtureFileText('src/checkout.ts').split('\n');
const hunks = fixtures.demoHunks();
const agentOf = () => 'Claude';

describe('hunk decorations', () => {
  it('parses the new side of a hunk patch', () => {
    expect(newSideOf(hunks[0]?.patch ?? '')).toEqual([
      { text: "import { sum } from './cart'", added: false },
      { text: "import { validate } from './validate'", added: true },
      { text: '', added: false },
    ]);
  });

  it('locates hunks by content, not by the recorded newStart', () => {
    // The fixture header says +5 but the context line sits on line 4 of the prototype file.
    expect(locateHunk(hunks[1] ?? { patch: '', newStart: 1 }, lines)).toBe(4);
    expect(addedLinesOf(hunks[1] ?? { patch: '', newStart: 1 }, lines)).toEqual([5, 8]);
  });

  it('falls back to newStart when the text drifted away', () => {
    expect(addedLinesOf(hunks[0] ?? { patch: '', newStart: 1 }, ['nothing', 'here'])).toEqual([2]);
  });

  it('matches hunk files against nested tree paths', () => {
    expect(hunkMatchesFile({ file: 'checkout.ts' }, 'src/checkout.ts')).toBe(true);
    expect(hunkMatchesFile({ file: 'checkout.ts' }, 'src/checkout.test.ts')).toBe(false);
  });

  it('decorates every added line and labels the first line of each hunk', () => {
    const decos = buildHunkDecorations({
      changes: hunks,
      path: 'src/checkout.ts',
      modelLines: lines,
      agentOf,
      now: fixtures.DEMO_NOW,
    });
    expect(decos.map((d) => [d.line, d.label])).toEqual([
      [2, 'Claude · 2m'],
      [5, 'Claude · 2m'],
      [8, null],
    ]);
  });

  it('ignores decided hunks and other files', () => {
    const changes = hunks.map((h, i) => (i === 0 ? { ...h, status: 'accepted' as const } : h));
    const decos = buildHunkDecorations({
      changes,
      path: 'src/checkout.ts',
      modelLines: lines,
      agentOf,
      now: fixtures.DEMO_NOW,
    });
    expect(decos.map((d) => d.line)).toEqual([5, 8]);
  });

  it('collects pending hunks of a worktree across sessions', () => {
    const model = fixtures.demoReadModel();
    expect(pendingHunksOf(model.hunks, fixtures.ids.worktree.fixCheckout)).toHaveLength(3);
    expect(pendingHunksOf(model.hunks, fixtures.ids.worktree.testFlaky)).toHaveLength(0);
  });

  it('builds the hunk bar label with the tests note only when the session note has one', () => {
    expect(hunkBarLabel(3, 'Claude', 'Added validation, 42 tests pass. Asking to open a PR.')).toBe(
      '3 hunks from Claude · 42 tests pass',
    );
    expect(hunkBarLabel(3, 'Claude', 'Rewriting README')).toBe('3 hunks from Claude');
    expect(hunkBarLabel(1, 'Codex', null)).toBe('1 hunks from Codex');
  });
});
