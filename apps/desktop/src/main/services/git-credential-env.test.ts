import { describe, expect, it } from 'vitest';
import { gitCredentialEnv } from './git-credential-env';

describe('session Git credential configuration', () => {
  it('adds only URL-specific GitHub settings after inherited configuration', () => {
    const base = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Person' };
    const env: Record<string, string> = { ...base, ...gitCredentialEnv(base) };
    expect(env.GIT_CONFIG_COUNT).toBe('4');
    expect(env.GIT_CONFIG_VALUE_0).toBe('Person');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_1).toBe('');
    expect(env.GIT_CONFIG_VALUE_2).toContain('"$STYX_EXE" "$STYX_CLI" credential');
    expect(env.GIT_CONFIG_KEY_3).toBe('credential.https://github.com.useHttpPath');
    expect(env.GIT_CONFIG_VALUE_3).toBe('true');
  });
  it.each(['-1', 'bad', '10001'])('refuses invalid inherited count %s', (count) => {
    expect(() => gitCredentialEnv({ GIT_CONFIG_COUNT: count })).toThrow(/configuration count/);
  });
});
