/**
 * Clipboard in the chat pane. The app-wide reset sets `user-select: none` on `body` (chrome must not select),
 * which also made every transcript message unselectable — ⌘C had nothing to copy out of a chat. jsdom does not
 * compute inherited `user-select`, so this behaviour can only be guarded from a real renderer.
 */
import { test, expect } from '@playwright/test';
import { launchStyx } from './launch';

test.describe('chat clipboard', () => {
  test('transcript text is selectable and copyable; chrome stays unselectable', async () => {
    const { app, page } = await launchStyx({
      screen: 'workspace',
      fixture: 'demo',
      theme: 'dark',
      platform: 'darwin',
    });
    await page.waitForSelector('[data-chat-pane]', { timeout: 10_000 });

    const selected = await page.evaluate(() => {
      const msg = document.querySelector(
        '[data-chat-pane] [data-kind="agent"], [data-chat-pane] [data-kind="user"]',
      );
      if (!msg) return { computed: 'no-message', text: '' };
      const range = document.createRange();
      range.selectNodeContents(msg);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return { computed: getComputedStyle(msg).userSelect, text: sel?.toString() ?? '' };
    });
    expect(selected.computed).toBe('text');
    expect(selected.text.trim().length).toBeGreaterThan(0);

    // Tabs, rail and titlebar must stay unselectable: dragging across them should never highlight.
    const chrome = await page.evaluate(() => {
      const tab = document.querySelector('[data-session-tab]');
      const rail = document.querySelector('[data-project-id]');
      return {
        tab: tab ? getComputedStyle(tab).userSelect : 'missing',
        rail: rail ? getComputedStyle(rail).userSelect : 'missing',
      };
    });
    expect(chrome.tab).toBe('none');
    expect(chrome.rail).toBe('none');

    // Paste into the composer (the other half of "copy and paste is broken").
    const composer = page.locator('[data-chat-pane] textarea').first();
    await composer.click();
    await composer.fill('');
    await page.evaluate(() => navigator.clipboard.writeText('styx-paste-probe'));
    await composer.press('Meta+V');
    await expect(composer).toHaveValue('styx-paste-probe');

    await app.close();
  });
});
