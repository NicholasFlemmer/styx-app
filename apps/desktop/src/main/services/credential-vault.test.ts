import { describe, expect, it } from 'vitest';
import { MemoryVault, makeCredentialRef } from './credential-vault';

describe('MemoryVault', () => {
  it('round-trips and lists refs', async () => {
    const v = new MemoryVault();
    const ref = makeCredentialRef('aws', 't1', 'key');
    expect(ref).toBe('styx:v1:aws:t1:key');
    await v.set(ref, '{"accessKeyId":"x"}');
    expect(await v.get(ref)).toContain('accessKeyId');
    expect(await v.listRefs()).toEqual([ref]);
    await v.delete(ref);
    expect(await v.exists(ref)).toBe(false);
  });
});
