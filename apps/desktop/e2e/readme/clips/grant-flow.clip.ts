/**
 * Clip: an agent asks for production access and the person approves it. Codex's task on the board is waiting with
 * an access request (Supabase prod, read + write); the request opens beside it, shows what the agent wants and why,
 * and is granted for one command. The grant lands in the chat. Each beat records where it happens on screen, and the
 * screen rests a moment before the next step so every state can be read.
 */
import { test } from '@playwright/test';
import { startScene } from './scene';

test('clip: grant-flow', async () => {
  const s = await startScene('grant-flow', { screen: 'workspace' });
  const { page } = s;
  await page.waitForSelector('[data-screen-ready="workspace"]');
  await s.moveTo(700, 470, 4);
  await s.hold(500);

  const card = page.locator('[data-tasks-card]').filter({ hasText: 'Fix the flaky order test' });
  await s.beat('board', card);
  const chip = await card.getByText('Requesting Supabase prod').boundingBox();
  if (chip) await s.moveTo(chip.x + chip.width / 2, chip.y + chip.height / 2);
  await s.hold(2400);

  await s.click(card.getByText('Fix the flaky order test and make sure the schema matches prod.'));
  const review = page.getByRole('button', { name: /^review request$/i });
  await review.waitFor();
  await s.beat('open-task', review);
  await s.hold(1800);

  await s.click(review);
  const sheet = page.getByRole('dialog', { name: /supabase/i });
  await sheet.waitFor();
  await s.hold(200);
  const why = sheet.getByText(/to run migration/);
  await s.beat('request', why);
  const whyBox = await why.boundingBox();
  if (whyBox) await s.moveTo(whyBox.x + whyBox.width * 0.7, whyBox.y + whyBox.height + 12, 20);
  await s.hold(2600);

  const grant = sheet.getByRole('button', { name: /^grant/i });
  await s.beat('scope', grant);
  const scope = await sheet.getByText('Write', { exact: true }).boundingBox();
  if (scope) await s.moveTo(scope.x + 120, scope.y + scope.height / 2, 18);
  await s.hold(2400);

  await s.click(grant, 700);
  const line = page.getByText(/grant: supabase-prod · read\+write/).first();
  await line.waitFor();
  await s.hold(200);
  await s.beat('granted', line);
  const lineBox = await line.boundingBox();
  if (lineBox) await s.moveTo(lineBox.x + lineBox.width - 40, lineBox.y + lineBox.height + 30, 22);
  await s.hold(3000);
  await s.beat('end');
  await s.finish();
});
