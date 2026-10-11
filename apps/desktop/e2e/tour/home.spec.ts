/**
 * Tour: every project in one window. The home screen's greeting, its counters (what needs you, what's working, grants)
 * and the projects with their lanes.
 */
import { test } from '@playwright/test';
import { startTour, steps } from './tour';

test('tour: every project in one window', async () => {
  const t = await startTour('home', { screen: 'home' });
  try {
    const { page } = t;
    await steps.homeReady(page);
    await steps.restPointer(page);
    const projects = page.getByRole('list', { name: 'Projects' });
    const rows = projects.getByRole('listitem');
    await t.reach('counters', page.locator('[data-home-counters]'));
    await t.reach('projects', projects, {
      acme: rows.nth(0),
      blog: rows.nth(1),
      infra: rows.nth(2),
      client: rows.nth(3),
      side: rows.nth(4),
    });
    for (const [k, name] of ['acme', 'blog', 'infra', 'client', 'side'].entries())
      await t.reach(`project-${name}`, rows.nth(k));
    await t.reach('greeting', page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ }));
  } finally {
    await t.close();
  }
});
