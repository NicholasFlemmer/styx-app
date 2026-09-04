import { describe, expect, it } from 'vitest';
import { FakeMfaProvider, MfaService, TouchIdProvider } from './mfa-service';

describe('MfaService', () => {
  it('maps Touch ID outcomes', async () => {
    const ok = new TouchIdProvider({ canPromptTouchID: () => true, promptTouchID: async () => {} });
    expect(await ok.verify('x')).toBe('ok');
    const cancelled = new TouchIdProvider({ canPromptTouchID: () => true, promptTouchID: async () => { throw new Error('User cancelled'); } });
    expect(await cancelled.verify('x')).toBe('cancelled');
    const none = new TouchIdProvider({ canPromptTouchID: () => false, promptTouchID: async () => {} });
    expect(await none.verify('x')).toBe('unavailable');
    expect(await new MfaService(new FakeMfaProvider('failed')).verify('x')).toBe('failed');
    expect(new MfaService(new FakeMfaProvider()).label).toBe('Touch ID');
  });
});
