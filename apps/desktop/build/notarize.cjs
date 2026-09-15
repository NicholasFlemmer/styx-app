/**
 * electron-builder `afterSign` hook: submits the signed .app to Apple's notary service and staples the ticket,
 * so Gatekeeper accepts it offline on a machine that has never seen it.
 *
 * Credentials come from one of two places, never from the repo:
 * - locally, the login keychain profile `styx-notary` (created once with `xcrun notarytool store-credentials`);
 * - in CI, an App Store Connect API key via APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID and APPLE_API_ISSUER.
 * Opt in with `STYX_NOTARIZE=1` so `package:mac:dir` and every local build stay offline and fast.
 * `pnpm release:preflight` checks all of this before a build is attempted.
 */
const { notarize } = require('@electron/notarize');

const PROFILE = process.env.APPLE_KEYCHAIN_PROFILE ?? 'styx-notary';

const credentials = () => {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    return {
      label: `api-key ${APPLE_API_KEY_ID}`,
      options: { appleApiKey: APPLE_API_KEY, appleApiKeyId: APPLE_API_KEY_ID, appleApiIssuer: APPLE_API_ISSUER },
    };
  }
  return { label: `keychain-profile ${PROFILE}`, options: { keychainProfile: PROFILE } };
};

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;
  if (process.env.STYX_NOTARIZE !== '1') {
    console.log('  • notarization skipped  reason=STYX_NOTARIZE is not 1 (local/dir build)');
    return;
  }
  const appPath = `${appOutDir}/${context.packager.appInfo.productFilename}.app`;
  const cred = credentials();
  console.log(`  • notarizing  app=${appPath} credentials=${cred.label}`);
  const started = Date.now();
  await notarize({ tool: 'notarytool', appPath, ...cred.options });
  console.log(`  • notarized and stapled  seconds=${Math.round((Date.now() - started) / 1000)}`);
};
