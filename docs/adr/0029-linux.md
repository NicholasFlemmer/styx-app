# ADR-0029: Linux (beta)

- Status: accepted (owner, 2026-10-06)
- Context: open-sourcing Styx. Many contributors work on Linux and couldn't run it at all; the owner asked for "the
  linux build" alongside the contributor guides.

## Decision

1. **Linux is a third platform, shipped as beta**: an AppImage (any distro, updates itself through electron-updater)
   and a .deb (Debian/Ubuntu, updated by the package manager). `pnpm package:linux` / `package:linux:dir`; CI builds,
   tests and smoke-tests it on `ubuntu-latest`, and the release workflow attaches both to the GitHub release.
2. **Layout and keys stay two-valued; words become three-valued.** Linux renders the Windows-style chrome (window
   controls through `titleBarOverlay`, Ctrl as the modifier), so `Platform` stays `darwin | win32` for layout and
   keyboard handling. User-facing words come from `platformCopy(CopyPlatform)`, where Linux has its own: "system
   password", "system keyring", bash, `~/code`. The renderer's `useCopyPlatform()` reads the real OS through
   `osPlatform()`.
3. **Production approvals use polkit** (`PolkitProvider`, `services/mfa-service.ts`). The .deb installs the action
   `com.heystyx.styx.approve-grant` (`build/linux/polkit`, `auth_self`: the person's own password, or a fingerprint
   where PAM has one), checked with `pkcheck --allow-user-interaction` under a Styx-named prompt. Without the action
   (AppImage), `pkexec /bin/true` gives the standard admin prompt. No graphical session, no polkit or no
   authentication agent is `unavailable`, which refuses the prod grant exactly as a Mac without Touch ID does. The
   invariant is unchanged: prod write/deploy/delete needs the OS to authenticate the person first, decided in main.
4. **Keyring**: `@napi-rs/keyring` uses the Secret Service (GNOME Keyring, KWallet) over D-Bus; the .deb depends on
   `libsecret-1-0`.
5. **Notifications**: desktop notifications (libnotify) with a Review button, and the tray icon Windows has (KDE
   natively; GNOME through the AppIndicator extension). There's no dock badge.

## Not in this decision

- Simulators: iOS needs a Mac; Android emulators work wherever `adb`/`emulator` are on PATH, as on Windows.
- Signing: AppImage and .deb are unsigned; the updater checks the feed's sha512 over HTTPS, as unsigned Windows
  builds do (#147).
- Distribution beyond the AppImage and .deb (Flatpak, Snap, AUR, rpm) is left to demand and contributors.

## Consequences

- Every platform branch in main must now handle `linux` deliberately: `=== 'darwin' ? mac : win` silently gives
  Linux the Windows path. Prefer `win32 ? … : posix` where the difference is POSIX vs Windows.
- Linux-specific behaviour is covered by unit tests (`PolkitProvider`, the Linux tray) and by CI on `ubuntu-latest`,
  including the Electron e2e suite under Xvfb and a packaged-app smoke.
