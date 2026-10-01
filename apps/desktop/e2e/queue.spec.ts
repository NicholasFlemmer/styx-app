/**
 * Queue or steer while a turn runs (owner request, modelled on t3code). A message sent while the agent is mid-turn is
 * never dropped: Codex over its app-server takes it into the running turn (`turn/steer`); every other runner holds
 * it as a dashed bubble under the transcript, sends it when the turn settles, and lets the user Send now or Take
 * back. Both fakes in e2e/fixtures/bin block their scripted turn on an approval, which is the mid-turn moment.
 * The composer's Queue / Steer send hint is unit-tested (ChatPane hides it under the harness, like the controls).
 */
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

type StyxWindow = Window & {
  styx: { command: (name: string, input: unknown) => Promise<{ ok: boolean; value?: unknown }> };
};

async function spawnWithFirstMessage(
  page: Awaited<ReturnType<typeof launchStyx>>['page'],
  agent: 'codex' | 'gemini',
) {
  await page.locator('[data-screen-ready="agents"]').waitFor({ state: 'attached', timeout: 20_000 });
  // The demo rows name binaries this machine does not have: re-detect so the fakes on PATH take over.
  await page.evaluate(() => (window as unknown as StyxWindow).styx.command('detect.clis', {}));
  await page.getByRole('button', { name: '+ Spawn agent' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-spawn-modal]')).toBeVisible();
  await dialog.locator(`[data-agent="${agent}"]`).click();
  await dialog.getByLabel('First message').fill('hi');
  await dialog.getByRole('button', { name: /^Spawn/ }).click();
  const chat = page.locator('[data-chat-pane]');
  await expect(chat).toBeVisible({ timeout: 20_000 });
  await expect(chat.locator('[data-kind="agent"]').filter({ hasText: 'pong' })).toBeVisible({
    timeout: 20_000,
  });
  // The scripted turn is now blocked on its approval: mid-turn, needs-you.
  const decision = chat.locator('[data-kind="decision"]');
  await expect(decision).toBeVisible({ timeout: 20_000 });
  await expect(chat.locator('[data-lane-meta]')).toContainText('waiting on you');
  return { chat, decision };
}

test('Codex steers: a message sent mid-turn reaches the running turn at once, nothing is queued', async () => {
  const { app, page } = await launchStyx({ screen: 'agents', fixture: 'demo', theme: 'dark', chrome: 'mac' });
  try {
    const { chat, decision } = await spawnWithFirstMessage(page, 'codex');

    const composer = chat.getByRole('textbox', { name: /^Message Codex/ });
    await composer.fill('also lint');
    await composer.press('Enter');
    // The user row appears now, the fake answers the steer inside the same turn, and no bubble waits.
    await expect(chat.locator('[data-kind="user"]').filter({ hasText: 'also lint' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(chat.locator('[data-kind="agent"]').filter({ hasText: 'steered: also lint' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(chat.locator('[data-queued]')).toHaveCount(0);
    await expect(composer).toHaveValue('');

    // The turn ends as before once the approval is answered.
    await decision.getByRole('button', { name: 'Allow' }).click();
    await expect(chat.locator('[data-lane-meta]')).not.toContainText('waiting on you', { timeout: 20_000 });
    // The command ran to completion (the chat shows it as a step, or a receipt once folded: ADR-0027 §3 / §4).
    await expect
      .poll(
        async () => {
          const snap = await page.evaluate(() =>
            (window as unknown as StyxWindow).styx.command('store.snapshot', {}),
          );
          const t = (
            snap.value as { transcripts: Record<string, { payload: { kind: string; status?: string } }[]> }
          ).transcripts;
          return Object.values(t)
            .flat()
            .some((m) => m.payload.kind === 'tool' && m.payload.status === 'ok');
        },
        { timeout: 20_000 },
      )
      .toBe(true);
  } finally {
    await app.close();
  }
});

test('Gemini queues: a message sent mid-turn waits as a dashed bubble, can be taken back, and goes out when the turn settles', async () => {
  const { app, page } = await launchStyx({ screen: 'agents', fixture: 'demo', theme: 'dark', chrome: 'mac' });
  try {
    const { chat, decision } = await spawnWithFirstMessage(page, 'gemini');

    const composer = chat.getByRole('textbox', { name: /^Message Gemini/ });
    await composer.fill('and then the tests');
    await composer.press('Enter');
    // Held: a dashed bubble under the transcript with the queue meta, no user row yet.
    const queued = chat.locator('[data-queued]');
    await expect(queued).toHaveCount(1, { timeout: 20_000 });
    await expect(queued).toContainText('and then the tests');
    await expect(queued).toContainText('Queued · Sent when the agent finishes this turn.');
    await expect(chat.locator('[data-kind="user"]').filter({ hasText: 'and then the tests' })).toHaveCount(0);
    await expect(composer).toHaveValue('');

    // Take back: the bubble goes and the text is back in the composer.
    await queued.getByRole('button', { name: 'Take back' }).click();
    await expect(queued).toHaveCount(0, { timeout: 20_000 });
    await expect(composer).toHaveValue('and then the tests');
    await expect(composer).toBeFocused();

    // Queue it again, then answer the approval: the turn settles and the held message goes out as the next turn.
    await composer.press('Enter');
    await expect(queued).toHaveCount(1, { timeout: 20_000 });
    await decision.getByRole('button', { name: 'Allow' }).click();
    await expect(chat.locator('[data-kind="user"]').filter({ hasText: 'and then the tests' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(queued).toHaveCount(0);
    // …and the fake runs that turn: a second pong and a second approval ask.
    await expect
      .poll(() => chat.locator('[data-kind="agent"]').filter({ hasText: 'pong' }).count(), {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(2);
    await expect(chat.locator('[data-kind="decision"]')).toHaveCount(2, { timeout: 20_000 });

    // Stop with a message held returns it to the composer with a system line.
    await composer.fill('one more');
    await composer.press('Enter');
    await expect(queued).toHaveCount(1, { timeout: 20_000 });
    const snapshot = await page.evaluate(() =>
      (window as unknown as StyxWindow).styx.command('store.snapshot', {}),
    );
    const session = (
      snapshot.value as { sessions: { id: string; agent: string; runner: string }[] }
    ).sessions.find((s) => s.agent === 'gemini' && s.runner === 'stream');
    expect(session).toBeDefined();
    await page.evaluate(
      (sessionId) => (window as unknown as StyxWindow).styx.command('session.interrupt', { sessionId }),
      session?.id,
    );
    await expect(queued).toHaveCount(0, { timeout: 20_000 });
    await expect(
      chat.locator('[data-kind="system"]').filter({ hasText: '1 queued message returned to the composer.' }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(composer).toHaveValue('one more');
  } finally {
    await app.close();
  }
});
