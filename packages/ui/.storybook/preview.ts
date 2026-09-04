import type { Decorator, Preview } from '@storybook/react-vite';
import { createElement } from 'react';
import '../src/styles/index.css';

export type StoryTheme = 'dark' | 'light';
export type StoryPlatform = 'mac' | 'win';

/** Mirrors what the renderer does: `data-theme` / `data-platform` on <html>, read by tokens.css and chrome components. */
const withThemeAndPlatform: Decorator = (Story, ctx) => {
  const theme: StoryTheme = ctx.globals['theme'] === 'light' ? 'light' : 'dark';
  const platform: StoryPlatform = ctx.globals['platform'] === 'win' ? 'win' : 'mac';
  const root = document.documentElement;
  root.dataset['theme'] = theme;
  root.dataset['platform'] = platform;
  root.style.colorScheme = theme;
  return createElement(Story);
};

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Resolved theme (sets data-theme on <html>)',
      toolbar: {
        title: 'Theme',
        icon: 'contrast',
        items: [
          { value: 'dark', title: 'Dark' },
          { value: 'light', title: 'Light' },
        ],
        dynamicTitle: true,
      },
    },
    platform: {
      description: 'Native chrome (sets data-platform on <html>)',
      toolbar: {
        title: 'Platform',
        icon: 'browser',
        items: [
          { value: 'mac', title: 'macOS' },
          { value: 'win', title: 'Windows' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'dark', platform: 'mac', backgrounds: { value: 'bg' } },
  decorators: [withThemeAndPlatform],
  parameters: {
    layout: 'padded',
    backgrounds: {
      options: {
        bg: { name: 'bg', value: 'var(--bg)' },
        s1: { name: 's1', value: 'var(--s1)' },
        s2: { name: 's2', value: 'var(--s2)' },
      },
    },
    controls: { matchers: { color: /(background|color)$/i } },
    a11y: { test: 'error' },
    options: {
      storySort: { order: ['Primitives', 'Layout', 'Feedback', 'Overlay', 'Chrome', 'Message', 'Hooks'] },
    },
  },
  tags: ['autodocs'],
};

export default preview;
