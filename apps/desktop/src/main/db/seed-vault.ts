import type { Target } from '@styx/core';
import type { CredentialVault } from '../services/credential-vault';

/**
 * Fixture targets carry `credentialRef`s but no secrets. When the in-memory vault is in use (dev/e2e), give each
 * connected fixture target a clearly fake credential so grant issuance works end to end. Never used with the real keychain.
 */
export function fixtureSecretFor(target: Pick<Target, 'provider'>): string {
  switch (target.provider) {
    case 'aws':
      return JSON.stringify({ accessKeyId: 'FIXTURE-ACCESS-KEY', secretAccessKey: 'FIXTURE-SECRET', region: 'us-east-1' });
    case 'gcp':
      return JSON.stringify({ client_email: 'fixture@example.iam.gserviceaccount.com', private_key: 'FIXTURE', project_id: 'fixture' });
    case 'ssh':
      return JSON.stringify({ keyPath: '/dev/null' });
    default:
      return JSON.stringify({ token: `FIXTURE-${target.provider.toUpperCase()}-TOKEN` });
  }
}

export async function seedFixtureVault(vault: CredentialVault, targets: readonly Target[]): Promise<number> {
  let n = 0;
  for (const t of targets) {
    if (!t.credentialRef || (await vault.exists(t.credentialRef))) continue;
    await vault.set(t.credentialRef, fixtureSecretFor(t));
    n++;
  }
  return n;
}
