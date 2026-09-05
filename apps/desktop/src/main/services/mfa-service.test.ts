import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeMfaProvider, helloArgs, MfaService, TouchIdProvider, WindowsHelloProvider } from './mfa-service';

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

describe('WindowsHelloProvider (PowerShell fallback)', () => {
  it('M4: runs a private temp .ps1 with -File and passes the reason as a bound parameter, never as script text', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'styx-mfa-'));
    const seen: { file: string; args: string[]; content: string; mode: number }[] = [];
    const run = async (file: string, args: string[]) => {
      const script = args[args.indexOf('-File') + 1] ?? '';
      seen.push({ file, args, content: readFileSync(script, 'utf8'), mode: statSync(script).mode & 0o777 });
      return 'RESULT:Verified';
    };
    const hello = new WindowsHelloProvider({ run, tmpDir, loadNative: false });
    const reason = 'Grant Codex write on supabase prod"; Remove-Item -Recurse C:\\ #\n$(calc)';
    expect(await hello.verify(reason)).toBe('ok');
    const call = seen[0];
    if (!call) throw new Error('runner not called');
    expect(call.file).toBe('powershell.exe');
    expect(call.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
    expect(call.args[5]).toMatch(/hello\.ps1$/);
    expect(call.args[6]).toBe('-Reason');
    expect(call.args[7]).toBe(reason.replace('\n', ' ')); // one argv element; only control chars are touched
    expect(call.args).toHaveLength(8);
    expect(call.content.startsWith("param([string]$Reason = '')")).toBe(true);
    expect(call.content).not.toContain(reason);
    expect(call.content).toContain('RequestVerificationAsync($Reason)');
    if (process.platform !== 'win32') expect(call.mode).toBe(0o600);
    expect(existsSync(call.args[5] ?? '')).toBe(false); // removed after the run
    expect(helloArgs('x.ps1', '\u0000\u0001')).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'x.ps1', '-Reason', 'Styx']);
  });

  it('maps availability and failures from the script output', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'styx-mfa-'));
    const unavailable = new WindowsHelloProvider({ run: async () => 'UNAVAILABLE:DeviceNotPresent', tmpDir, loadNative: false });
    expect(await unavailable.available()).toBe(false);
    expect(await unavailable.verify('x')).toBe('unavailable');
    const cancelled = new WindowsHelloProvider({ run: async () => 'RESULT:Canceled', tmpDir, loadNative: false });
    expect(await cancelled.verify('x')).toBe('cancelled');
    const broken = new WindowsHelloProvider({ run: async () => { throw new Error('no powershell'); }, tmpDir, loadNative: false });
    expect(await broken.verify('x')).toBe('unavailable');
    expect(await new WindowsHelloProvider({ run: async () => 'garbage', tmpDir, loadNative: false }).verify('x')).toBe('failed');
  });
});
