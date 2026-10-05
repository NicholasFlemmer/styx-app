/**
 * Test time limits, stretched on CI. Hosted runners (GitHub's macOS VMs in particular) run git 15-30x slower than
 * a developer machine, so a suite that shells out to git hundreds of times needs far longer there. The tests are
 * the same; only how long they may take changes. Local runs keep the tight limits that catch real regressions.
 */
export const TIMEOUT_SCALE = process.env['CI'] ? 4 : 1;

/** `ms` on a developer machine, `ms × TIMEOUT_SCALE` on CI. */
export const slow = (ms: number): number => ms * TIMEOUT_SCALE;
