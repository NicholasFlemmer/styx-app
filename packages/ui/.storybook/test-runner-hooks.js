// Every story must be axe clean (packages/ui/CLAUDE.md). Registered via test-runner-jest.config.js.
import { setPostVisit, setPreVisit } from '@storybook/test-runner';
import { checkA11y, injectAxe } from 'axe-playwright';

setPreVisit(async (page) => {
  await injectAxe(page);
});

setPostVisit(async (page) => {
  await checkA11y(page, '#storybook-root', {
    detailedReport: true,
    detailedReportOptions: { html: true },
  });
});
