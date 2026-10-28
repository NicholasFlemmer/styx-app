/** Git's URL-specific empty helper resets earlier helpers for GitHub without changing other hosts. */
export function gitCredentialEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const count = env['GIT_CONFIG_COUNT'] ?? '0';
  if (!/^\d+$/.test(count) || Number(count) > 10_000)
    throw new Error('invalid inherited Git configuration count');
  const start = Number(count);
  const settings: readonly (readonly [string, string])[] = [
    ['credential.https://github.com.helper', ''],
    [
      'credential.https://github.com.helper',
      '!env ELECTRON_RUN_AS_NODE=1 "$STYX_EXE" "$STYX_CLI" credential',
    ],
    ['credential.https://github.com.useHttpPath', 'true'],
  ];
  const result: Record<string, string> = { GIT_CONFIG_COUNT: String(start + settings.length) };
  for (const [i, [key, value]] of settings.entries()) {
    result[`GIT_CONFIG_KEY_${start + i}`] = key;
    result[`GIT_CONFIG_VALUE_${start + i}`] = value;
  }
  return result;
}
