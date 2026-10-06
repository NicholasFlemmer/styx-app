import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FakeMfaProvider,
  helloArgs,
  macPasswordArgs,
  MfaService,
  POLKIT_ACTION,
  PolkitProvider,
  TouchIdProvider,
  WindowsHelloProvider,
} from './mfa-service';

describe('MfaService', () => {
  it('maps Touch ID outcomes', async () => {
    const ok = new TouchIdProvider({ canPromptTouchID: () => true, promptTouchID: async () => {} });
    expect(await ok.verify('x')).toBe('ok');
    const cancelled = new TouchIdProvider({
      canPromptTouchID: () => true,
      promptTouchID: async () => {
        throw new Error('User cancelled');
      },
    });
    expect(await cancelled.verify('x')).toBe('cancelled');
    const promptTouchID = vi.fn(async () => {});
    const calls: string[][] = [];
    const noSensor = (exitCode: number, stderr = '') =>
      new TouchIdProvider({ canPromptTouchID: () => false, promptTouchID }, async (args) => {
        calls.push(args);
        return { exitCode, stderr };
      });
    // No Touch ID: the system password prompt instead of a refusal.
    expect(await noSensor(0).verify('Grant Codex write on Supabase prod')).toBe('ok');
    expect(await noSensor(1, 'execution error: User canceled. (-128)').verify('x')).toBe('cancelled');
    expect(await noSensor(1, 'execution error: wrong password').verify('x')).toBe('failed');
    expect(await noSensor(0).available()).toBe(true);
    expect(promptTouchID).not.toHaveBeenCalled();
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
    expect(call.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
    ]);
    expect(call.args[5]).toMatch(/hello\.ps1$/);
    expect(call.args[6]).toBe('-Reason');
    expect(call.args[7]).toBe(reason.replace('\n', ' ')); // one argv element; only control chars are touched
    expect(call.args).toHaveLength(8);
    expect(call.content.startsWith("param([string]$Reason = '')")).toBe(true);
    expect(call.content).not.toContain(reason);
    expect(call.content).toContain('RequestVerificationAsync($Reason)');
    if (process.platform !== 'win32') expect(call.mode).toBe(0o600);
    expect(existsSync(call.args[5] ?? '')).toBe(false); // removed after the run
    expect(helloArgs('x.ps1', '\u0000\u0001')).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'x.ps1',
      '-Reason',
      'Styx',
    ]);
  });

  it('maps availability and failures from the script output', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'styx-mfa-'));
    const unavailable = new WindowsHelloProvider({
      run: async () => 'UNAVAILABLE:DeviceNotPresent',
      tmpDir,
      loadNative: false,
    });
    expect(await unavailable.available()).toBe(false);
    expect(await unavailable.verify('x')).toBe('unavailable');
    const cancelled = new WindowsHelloProvider({
      run: async () => 'RESULT:Canceled',
      tmpDir,
      loadNative: false,
    });
    expect(await cancelled.verify('x')).toBe('cancelled');
    const broken = new WindowsHelloProvider({
      run: async () => {
        throw new Error('no powershell');
      },
      tmpDir,
      loadNative: false,
    });
    expect(await broken.verify('x')).toBe('unavailable');
    expect(
      await new WindowsHelloProvider({ run: async () => 'garbage', tmpDir, loadNative: false }).verify('x'),
    ).toBe('failed');
  });
});

describe('PolkitProvider (Linux)', () => {
  const GUI = { DISPLAY: ':0' };
  const bins =
    (...have: string[]) =>
    async (bin: string) =>
      have.includes(bin) ? `/usr/bin/${bin}` : null;
  const runner = (codes: Record<string, number>, stderr = '') => {
    const calls: { bin: string; args: string[] }[] = [];
    const run = async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      return { exitCode: codes[bin.split('/').at(-1) ?? ''] ?? -1, stderr };
    };
    return { calls, run };
  };

  it('asks for your own password through the Styx action when the .deb installed it', async () => {
    const r = runner({ pkcheck: 0 });
    const p = new PolkitProvider({ run: r.run, which: bins('pkcheck', 'pkexec'), env: GUI, pid: 4242 });
    expect(await p.verify()).toBe('ok');
    expect(r.calls).toEqual([
      {
        bin: '/usr/bin/pkcheck',
        args: ['--action-id', POLKIT_ACTION, '--process', '4242', '--allow-user-interaction'],
      },
    ]);
  });

  it.each([
    [3, 'cancelled'],
    [1, 'failed'],
    [2, 'failed'],
  ] as const)('pkcheck exit %i is %s, with no second prompt', async (code, result) => {
    const r = runner({ pkcheck: code });
    const p = new PolkitProvider({ run: r.run, which: bins('pkcheck', 'pkexec'), env: GUI });
    expect(await p.verify()).toBe(result);
    expect(r.calls).toHaveLength(1);
  });

  it('without the action (AppImage) falls back to the standard pkexec prompt', async () => {
    const r = runner({ pkcheck: 4, pkexec: 0 });
    const p = new PolkitProvider({ run: r.run, which: bins('pkcheck', 'pkexec'), env: GUI });
    expect(await p.verify()).toBe('ok');
    expect(r.calls.map((c) => c.bin)).toEqual(['/usr/bin/pkcheck', '/usr/bin/pkexec']);
    expect(r.calls[1]?.args).toEqual(['--disable-internal-agent', '/bin/true']);
  });

  it.each([
    [126, '', 'cancelled'],
    [127, '', 'failed'],
    [127, 'Error: No authentication agent found.', 'unavailable'],
  ] as const)('pkexec exit %i (%s) is %s', async (code, stderr, result) => {
    const r = runner({ pkexec: code }, stderr);
    const p = new PolkitProvider({ run: r.run, which: bins('pkexec'), env: GUI });
    expect(await p.verify()).toBe(result);
  });

  it('is unavailable with no graphical session or no polkit, and then never prompts', async () => {
    const r = runner({ pkcheck: 0, pkexec: 0 });
    const headless = new PolkitProvider({ run: r.run, which: bins('pkcheck', 'pkexec'), env: {} });
    expect(await headless.available()).toBe(false);
    expect(await headless.verify()).toBe('unavailable');
    const none = new PolkitProvider({ run: r.run, which: bins(), env: GUI });
    expect(await none.available()).toBe(false);
    expect(await none.verify()).toBe('unavailable');
    expect(r.calls).toEqual([]);
    expect(new PolkitProvider().label).toBe('system password');
  });
});

describe('macPasswordArgs', () => {
  it('passes the reason as an argument, never inside the script, so a name cannot inject AppleScript', () => {
    const evil = 'Supabase" & (do shell script "rm -rf ~") & "\n';
    const args = macPasswordArgs(evil);
    expect(args.slice(0, 6).join(' ')).not.toContain('rm -rf');
    expect(args.at(-1)).toBe('Supabase" & (do shell script "rm -rf ~") & "');
    expect(args).toContain(
      'do shell script "/usr/bin/true" with prompt (item 1 of argv) with administrator privileges',
    );
  });
});
