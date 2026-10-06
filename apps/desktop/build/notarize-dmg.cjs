/**
 * electron-builder `afterAllArtifactBuild` hook: notarizes the signed .dmg itself, not only the app inside it, so
 * no Mac security setup can flag the disk image as unverified. (The first-open "downloaded from the Internet"
 * question is macOS asking about any downloaded app; a notarized app gets the mild version with an Open button,
 * and nothing removes it but the App Store.)
 *
 * The ticket is not stapled to the .dmg: stapling rewrites the file after `latest-mac.yml` has recorded its size
 * and hash. Gatekeeper finds the ticket online, and the app inside carries its own stapled ticket for offline use.
 * Same credentials and the same `STYX_NOTARIZE=1` opt-in as build/notarize.cjs.
 */
const { execFileSync } = require('node:child_process');

const PROFILE = process.env.APPLE_KEYCHAIN_PROFILE ?? 'styx-notary';

const credentialArgs = () => {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER)
    return ['--key', APPLE_API_KEY, '--key-id', APPLE_API_KEY_ID, '--issuer', APPLE_API_ISSUER];
  return ['--keychain-profile', PROFILE];
};

exports.default = async function notarizeDmg(buildResult) {
  const dmgs = (buildResult.artifactPaths ?? []).filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) return [];
  if (process.env.STYX_NOTARIZE !== '1') {
    console.log('  • dmg notarization skipped  reason=STYX_NOTARIZE is not 1 (local build)');
    return [];
  }
  for (const dmg of dmgs) {
    const started = Date.now();
    console.log(`  • notarizing dmg  file=${dmg}`);
    // Apple's service and the network both blip: a submission that errors (not one Apple rejects) is retried.
    let result;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const out = execFileSync(
          'xcrun',
          ['notarytool', 'submit', dmg, ...credentialArgs(), '--wait', '--output-format', 'json'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
        );
        result = JSON.parse(out);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        console.log(`  • dmg notarization errored, retrying  attempt=${attempt}`);
        await new Promise((r) => setTimeout(r, 30_000 * attempt));
      }
    }
    if (result.status !== 'Accepted')
      throw new Error(`dmg notarization ${result.status ?? 'failed'} (id ${result.id}); see: xcrun notarytool log ${result.id}`);
    console.log(`  • dmg notarized  seconds=${Math.round((Date.now() - started) / 1000)} id=${result.id}`);
  }
  return [];
};
