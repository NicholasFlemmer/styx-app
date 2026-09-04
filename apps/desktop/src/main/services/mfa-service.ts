import { execa } from 'execa';

export type MfaResult = 'ok' | 'failed' | 'unavailable' | 'cancelled';

export interface MfaProvider {
  available(): Promise<boolean>;
  verify(reason: string): Promise<MfaResult>;
  label: string; // "Touch ID" | "Windows Hello"
}

/** macOS: Touch ID via Electron's systemPreferences (LocalAuthentication); the OS handles the password fallback. */
export class TouchIdProvider implements MfaProvider {
  label = 'Touch ID';
  constructor(private readonly sp: { canPromptTouchID(): boolean; promptTouchID(reason: string): Promise<void> }) {}
  async available(): Promise<boolean> {
    return this.sp.canPromptTouchID();
  }
  async verify(reason: string): Promise<MfaResult> {
    if (!this.sp.canPromptTouchID()) return 'unavailable';
    try {
      await this.sp.promptTouchID(reason);
      return 'ok';
    } catch (e) {
      return /cancel/i.test(String((e as Error).message)) ? 'cancelled' : 'failed';
    }
  }
}

const HELLO_PS = `
[Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$avail = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
if ($avail -ne 'Available') { Write-Output "UNAVAILABLE:$avail"; exit 0 }
$r = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($args[0])) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
Write-Output "RESULT:$r"
`;

/** Windows Hello via WinRT UserConsentVerifier. Prefers the native addon when present, else a PowerShell 5.1 shim. */
export class WindowsHelloProvider implements MfaProvider {
  label = 'Windows Hello';
  private native: { checkAvailability(): Promise<string>; requestVerification(reason: string): Promise<string> } | null = null;

  private async loadNative(): Promise<typeof this.native> {
    if (this.native) return this.native;
    try {
      const mod = '@styx/native-winhello'; // optional napi addon; resolved at runtime only, hidden from the bundler
      this.native = (await import(/* @vite-ignore */ mod)) as typeof this.native;
    } catch {
      this.native = null;
    }
    return this.native;
  }

  async available(): Promise<boolean> {
    const n = await this.loadNative();
    if (n) return (await n.checkAvailability()) === 'Available';
    const r = await this.runPs('__check__');
    return !r.startsWith('UNAVAILABLE');
  }

  async verify(reason: string): Promise<MfaResult> {
    const n = await this.loadNative();
    if (n) return mapHello(await n.requestVerification(reason));
    const out = await this.runPs(reason);
    if (out.startsWith('UNAVAILABLE')) return 'unavailable';
    const m = /RESULT:(\w+)/.exec(out);
    return m?.[1] ? mapHello(m[1]) : 'failed';
  }

  private async runPs(reason: string): Promise<string> {
    try {
      const r = await execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', HELLO_PS, reason], { reject: false, timeout: 120_000 });
      return String(r.stdout ?? '');
    } catch {
      return 'UNAVAILABLE:error';
    }
  }
}

function mapHello(r: string): MfaResult {
  switch (r) {
    case 'Verified':
      return 'ok';
    case 'Canceled':
      return 'cancelled';
    case 'DeviceNotPresent':
    case 'NotConfiguredForUser':
    case 'DisabledByPolicy':
      return 'unavailable';
    default:
      return 'failed';
  }
}

/** Test/dev provider (`STYX_MFA=auto|deny`). */
export class FakeMfaProvider implements MfaProvider {
  label = 'Touch ID';
  constructor(private readonly outcome: MfaResult = 'ok') {}
  async available(): Promise<boolean> {
    return this.outcome !== 'unavailable';
  }
  async verify(): Promise<MfaResult> {
    return this.outcome;
  }
}

/** The MFA gate. `requireMfa` is decided by GrantService from DB rows; this only performs the OS prompt. Results are never cached. */
export class MfaService {
  constructor(private readonly provider: MfaProvider) {}
  get label(): string {
    return this.provider.label;
  }
  available(): Promise<boolean> {
    return this.provider.available();
  }
  verify(reason: string): Promise<MfaResult> {
    return this.provider.verify(reason);
  }
}
