import type { Decorator } from '@storybook/react-vite';

export type SurfaceToken = 'bg' | 's1';

/** Wraps a story in a padded surface so hairlines and hover fills can be judged against `--bg` or `--s1`. */
export function withSurface(bg: SurfaceToken): Decorator {
  return (Story) => (
    <div data-surface={bg} style={{ background: `var(--${bg})`, padding: 'var(--sp-4)', display: 'inline-block' }}>
      <Story />
    </div>
  );
}
