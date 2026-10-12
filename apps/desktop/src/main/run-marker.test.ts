import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { crashDumpTimes, previousRunEnding, quittingMarker, runningMarker } from './run-marker';

describe('previousRunEnding', () => {
  it.each([
    ['no marker: a clean quit', null, [], []],
    ['still running, no dump', runningMarker(1000), [], ['app.ended-unexpectedly']],
    ['still running, a dump from before it started', runningMarker(1000), [999], ['app.ended-unexpectedly']],
    [
      'still running, a dump written during the run',
      runningMarker(1000),
      [999, 1500],
      ['app.ended-unexpectedly', 'app.crashed.main'],
    ],
    [
      'a marker from before the prefix (bare start time)',
      '1000',
      [1500],
      ['app.ended-unexpectedly', 'app.crashed.main'],
    ],
    ['quitting: the quit hung and was killed', quittingMarker(2000), [2500], ['app.ended-while-quitting']],
    ['unreadable marker', 'garbage', [1500], ['app.ended-unexpectedly']],
  ] as const)('%s', (_name, text, dumps, expected) => {
    expect(previousRunEnding(text, dumps)).toEqual(expected);
  });
});

describe('crashDumpTimes', () => {
  const base = mkdtempSync(join(tmpdir(), 'styx-run-marker-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('finds .dmp files up to two levels down and ignores everything else', () => {
    mkdirSync(join(base, 'completed'), { recursive: true });
    mkdirSync(join(base, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(base, 'completed', 'one.dmp'), '');
    writeFileSync(join(base, 'completed', 'notes.txt'), '');
    writeFileSync(join(base, 'a', 'b', 'c', 'too-deep.dmp'), '');
    utimesSync(join(base, 'completed', 'one.dmp'), 1_700_000_000, 1_700_000_000);
    expect(crashDumpTimes(base)).toEqual([1_700_000_000_000]);
  });

  it('returns nothing for a folder that does not exist', () => {
    expect(crashDumpTimes(join(base, 'missing'))).toEqual([]);
  });
});
