# ADR-0022 The design window as a simulator: device runs, live mirror, turn screenshots

Status: accepted · 2026-09-18 (owner request)

The design window (owner addition, discrepancies #57 / #69 / #80) shows the project's web app at a local URL
beside the code, with Desktop / Tablet / Phone width presets and a `Run locally` that an agent teaches Styx
once. The owner showed the thing he wants it to be: an editor on one side, Xcode's iOS Simulator on the other,
the login screen redrawing on every save — "a simulator / emulator that literally displays as the build is
happening". This Mac has neither Xcode nor the Android SDK, so the work was built and verified against fakes
and is marked below where real hardware has not been under it.

## Decision

**A run has a platform.** `DevRun.platform` is `web | ios | android`; a project remembers `devPlatform`,
`devDevice` (a simulator by _name_, `iPhone 17 Pro`, since a UDID is per machine) and `devAppId` in
`.styx/project.json` `dev.*` — identifiers only, validated by `DEVICE_NAME` / `APP_ID` on both the file and the
`remember_command` path so a committed file cannot smuggle a command into either. `run.detect` recognises Expo
(`expo` dependency + `app.json` / `app.config.*`), bare React Native (`react-native` + `ios/` / `android/`),
Flutter (`pubspec.yaml`), an Xcode project / workspace and a Gradle project, and returns `platforms` (device
platforms first for a mobile app) with suggestions such as `npx expo run:ios`. The learn prompt gets a mobile
addendum: run it on a simulator, and report platform, device name and bundle id through `remember_command`
(whose schema and MCP tool description gained `platform`, `device`, `appId`). A device run boots the device
first and never adopts a URL the command prints (Metro's is not a page).

**One device session per project, main-owned, in memory.** `DeviceService` (`services/device-service.ts`)
speaks to the platform's own tooling on the login shell's PATH, args arrays only: `xcrun simctl list devices
available -j` → `simctl boot` (149 = already booted) → `simctl bootstatus -b` → `open -a Simulator --args
-CurrentDeviceUDID` for iOS; `emulator -list-avds` / `emulator -avd <name>` (detached) → `adb devices -l` →
`adb shell getprop sys.boot_completed` for Android. The session (`model.devices[projectId]`, delta
`devices.set`) reads `booting → ready | failed`, carries the screen size (from the first screenshot's PNG header
/ `adb shell wm size`), the mirror mode and whether input is possible. It outlives the run command (`expo
run:ios` may exit while the simulator keeps showing the app) and is stopped explicitly (`Stop simulator` keeps
the simulator up; `Shut down` runs `simctl shutdown` / `adb emu kill`).

**Mirroring prefers the simulator's own window, falls back to screenshots.** macOS will not let one app embed
another's window, so the pane captures it: `device.mirror` finds the Simulator / Emulator window among
Electron's `desktopCapturer` sources by title (`<device> – <runtime>`, `Android Emulator - <avd>:<port>`), arms
it, and the renderer calls `getDisplayMedia`; main's `setDisplayMediaRequestHandler` answers with exactly that
one window, once — never the system picker, never a whole screen, and anything else asking is refused. That
needs macOS Screen Recording, asked for once; until it is granted, or when the window is not there (a headless
emulator, no Xcode), the service polls `simctl io … screenshot` / `adb exec-out screencap -p` at ~2 fps into an
in-memory `ScreensStore` and the pane swaps an `<img src="styx-device://frame/<project>?seq=n">` on each
`device.frame` event. Polling runs only while a pane is watching (the pane re-calls `device.mirror` every 30 s;
the poller stops 60 s after the last call; a live capture needs no heartbeat and never re-arms). The armed
window is handed over once, only to a registered Styx window at the renderer's origin, and only within 10 s of
being armed (`ARM_TTL_MS`); the design window's page runs on its own session partition (`styx-preview`) with
every permission refused, so the user's app — or a script it loads — can neither ask for the capture nor read a
picture by URL. The title match requires the runtime after the dash when it is known (`iPhone 17 Pro – iOS
26.5`, not a browser tab about the phone) and gives up when two windows qualify. `styx-device://` is a
privileged scheme served from the store; the renderer's CSP allows it for images only, and no picture ever
travels through the store deltas or SQLite. What a tool prints on failure is `redact()`ed before it reaches a
session row.

The exact argv, so a mismatch on real hardware is a one-line fix:

| Operation        | Command                                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tooling          | `xcrun simctl help` · `adb version` · `which xcrun` / `adb` / `idb` (xcrun, idb on macOS only)                                                                                                                                         |
| list             | `xcrun simctl list devices available -j` · `emulator -list-avds` · `adb devices -l`                                                                                                                                                    |
| boot iOS         | `xcrun simctl boot <udid>` (149 = booted already) → `xcrun simctl bootstatus <udid> -b` (180 s) → `open -a Simulator --args -CurrentDeviceUDID <udid>` (failure logged) → one screenshot for the screen size (PNG IHDR)                |
| boot Android     | spawn `emulator -avd <name> -no-boot-anim` detached → `adb devices -l` every 2 s, `adb -s <serial> emu avd name` to find ours → `adb -s <serial> shell getprop sys.boot_completed` until `1` (180 s) → `adb -s <serial> shell wm size` |
| screenshot       | `xcrun simctl io <udid> screenshot --type=png <tmp>/styx-shot-<ulid>.png` (read, removed) · `adb -s <serial> exec-out screencap -p`                                                                                                    |
| input Android    | `adb -s S shell input tap x y` · `input swipe x1 y1 x2 y2 ms` · `input keyevent KEYCODE_ENTER\|DEL\|HOME\|BACK\|ESCAPE` · `input text <t>` (spaces as `%s`)                                                                            |
| input iOS        | `idb describe --udid U --json` once (density) · `idb ui tap x y --udid U` · `idb ui swipe x1 y1 x2 y2 --duration s --udid U` · `idb ui key 40\|42\|41 --udid U` · `idb ui button HOME --udid U` · `idb ui text <t> --udid U`           |
| focus · shutdown | `open -a Simulator` · `xcrun simctl shutdown <udid>` / `adb -s <serial> emu kill`                                                                                                                                                      |

The tool lookup puts the process PATH before the login shell's (as `execaPublishExec` does), which is what
lets the e2e fakes shadow `/usr/bin/xcrun` and `/usr/bin/open`.

**The pane is keyboard-honest.** With an input bridge the picture is an `application` region (assistive tech
passes keys through; its description says so) with a focus ring drawn on the unscaled stage; without one it is
a plain picture and a row that stays explains why and names `Open the simulator`. Nothing with words or a
button is rendered inside the scaled frame — booting, "no picture", the empty and waiting states sit in a
full-size layer over it — so type stays readable and targets stay 28 px at any scale.

**Input goes through the tooling that has it.** Android: `adb shell input tap | swipe | text | keyevent`, with
`text` limited to a character whitelist because `adb shell` re-parses on the device. iOS: `idb ui tap | swipe |
text | key` when Meta's `idb` is installed; otherwise the pane says so and offers `Open the simulator`
(`open -a Simulator`). The pane maps pointer events from the frame's on-screen rect to device pixels
(`session.screen`) and batches typing into `text` calls (300 ms idle); `idb ui tap` takes _points_, so iOS
coordinates are divided by the density `idb describe` reports. Text is refused outside a plain-punctuation
whitelist and coordinates outside the screen are refused, before anything runs.

**A device frame for web apps too.** The Phone / Tablet presets draw `DeviceFrame` (`packages/ui`) around the
native web view — square corners (radius 0 is a rule), 1px `--tx` frame, a mono status strip, a notch bar on
the phone, a home line, `Rotate` — and the renderer now owns that layout: the hole reported to `preview.set`
is the frame's screen slot, scaled down with the pane (`transform: scale()`) when it is narrower than the
device; main trusts the reported rect and zooms the page by the same factor (`setZoomFactor`) so the page's
`innerWidth` stays the device's width and media queries agree with the frame.

**Every turn keeps a Before / After.** `CheckpointService` asks for a screenshot when a turn starts and when it
settles — the mirrored device if one is ready, else the design window's page through
`webContents.capturePage()` (only for the project whose page is loaded: a live web run, or a saved `devUrl`
with no run). The files live under `userData/screens/<checkpointId>-<side>.png`, the row records which sides
exist (`Checkpoint.screens`, migration 0016), the Review screen shows them side by side above the patch, and
`prune()` drops them with the row. A capture is awaited inside the session's queued operation (after the row's first
publish, so strict before → after order costs no bookkeeping) and abandoned after 5 s; one that fails or
returns nothing changes nothing. A turn still open when the next starts (a pty session) shares its `after`
with the new turn's `before` — one picture, like the one git snapshot. The page is only used when the design
window has _this project's_ URL loaded (`PreviewService.loadedUrl()` against the live run's URL or the saved
`devUrl`), so a settle in project B never keeps a picture of project A.

## Consequences

- **Unverified on real hardware:** the live window capture (title match, Screen Recording), `idb` input, a
  real `simctl boot` / `emulator -avd`, and the app-id launch path. Everything the e2e covers runs against fake
  `xcrun` / `adb` / `emulator` / `open` on `e2e/fixtures/bin`: boot, screenshots-mode mirroring, the platform
  chips, the device picker, the status bar item, stop. The first run on a Mac with Xcode should be treated as a
  test; the argv are listed in `device-service.ts` and this ADR so a mismatch is a one-line fix.
- Screenshots-mode costs a `simctl io screenshot` (~100–300 ms) twice a second while the pane is watching, and
  nothing when it is not. Window mode costs what screen sharing costs.
- Checkpoint pictures are plain PNGs under `userData/screens`, kept for a session's newest 40 turns
  (`SCREENS_KEEP_TURNS`; older rows keep their patch, lose their pictures) and dropped with the row. They show
  whatever the app showed — a form with a password typed into it, say — and cannot be redacted the way text
  is; that is accepted, the directory being the user's own and never leaving the machine.
- `remember_command` shares the per-session request meter (5 / min): a looping learn-run agent cannot churn
  the project file or flood the chat.
- A device session belongs to the project, not the worktree: two sessions in different worktrees of one
  project share the simulator, and both their checkpoints screenshot the same screen. That is what a phone on
  the desk would do too.
- The Simulator's window still exists on the desktop (Styx cannot hide another app's window); the mirror is a
  view of it, and the user can always bring it forward to interact when input is not bridged.
- Discrepancy #94. Copy additions under `workspace.device.*`, `workspace.design.rotate / frameLabel`,
  `workspace.run.*Device`, `checkpoints.screens*`, `abilities.learnedRunDevice*` and the `learnRunDevice`
  prompt addendum are not in §10.
