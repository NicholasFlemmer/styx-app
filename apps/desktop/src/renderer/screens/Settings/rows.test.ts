import { DEFAULT_PROJECT_SETTINGS } from '@styx/core';
import { describe, expect, it } from 'vitest';
import { projectSettingChanged } from './rows';

/**
 * #35: the machine-only lane settings (#10) never come from `.styx/project.json`, so "changed" and Reset follow
 * this machine's value against the default, not where the value was stored.
 */
describe('projectSettingChanged', () => {
  it.each([
    ['a file setting the file sets', 'branchPrefix', { value: 'agent/', source: 'project' }, true],
    ['a file setting left at the default', 'branchPrefix', { value: 'agent/', source: 'default' }, false],
    ['nothing stored', 'autoLand', undefined, false],
    [
      'a machine setting stored at its default value',
      'autoLand',
      { value: DEFAULT_PROJECT_SETTINGS.autoLand, source: 'project' },
      false,
    ],
    [
      'a machine setting changed on this machine',
      'autoLand',
      { value: !DEFAULT_PROJECT_SETTINGS.autoLand, source: 'project' },
      true,
    ],
    [
      'a machine setting changed but reported as a default',
      'syncOnSpawn',
      { value: !DEFAULT_PROJECT_SETTINGS.syncOnSpawn, source: 'default' },
      true,
    ],
  ] as const)('%s', (_name, key, entry, expected) => {
    expect(projectSettingChanged(key, entry)).toBe(expected);
  });
});
