/**
 * electron-builder `afterSign` hook: submits the signed .app to Apple's notary service and staples the ticket,
 * so Gatekeeper accepts it offline on a machine that has never seen it.
 *
 * Credentials live in the login keychain under the `styx-notary` profile (created with
 * `xcrun notarytool store-credentials`), never in the repo or the environment. Opt in with `STYX_NOTARIZE=1`
 * so `package:mac:dir` and every local build stay offline and fast.
 */
const { notarize } = require('@electron/notarize');

const PROFILE = process.env.APPLE_KEYCHAIN_PROFILE ?? 'styx-notary';

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;
  if (process.env.STYX_NOTARIZE !== '1') {
    console.log('  • notarization skipped  reason=STYX_NOTARIZE is not 1');
    return;
  }
  const appPath = `${appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log(`  • notarizing  app=${appPath} profile=${PROFILE}`);
  const started = Date.now();
  await notarize({ tool: 'notarytool', appPath, keychainProfile: PROFILE });
  console.log(`  • notarized and stapled  seconds=${Math.round((Date.now() - started) / 1000)}`);
};
