import type { Meta, StoryObj } from '@storybook/react-vite';
import { withSurface } from '../../storybook/decorators';
import { renderMatrix } from '../../storybook/matrix';
import { Button, type ButtonSize, type ButtonVariant } from './Button';

const VARIANTS = [
  'secondary',
  'primary',
  'accent',
  'ghost',
  'dashed',
] as const satisfies readonly ButtonVariant[];
const SIZES = ['compact', 'regular', 'hunk', 'footer'] as const satisfies readonly ButtonSize[];

const meta = {
  title: 'Primitives/Button',
  component: Button,
  args: { children: 'Grant', variant: 'secondary', size: 'compact' },
  argTypes: {
    variant: { control: 'select', options: VARIANTS },
    size: { control: 'select', options: SIZES },
    inv: { control: 'boolean' },
    on: { control: 'boolean' },
    disabled: { control: 'boolean' },
    grow: { control: 'number' },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** Spec §8: five variants × four paddings. `footer` is full-width, so it gets a fixed-width cell. */
export const Matrix: Story = {
  render: () =>
    renderMatrix(
      VARIANTS,
      SIZES,
      (variant, size) => (
        <Button variant={variant} size={size}>
          {variant}
        </Button>
      ),
      { rowTitle: 'variant', colTitle: 'size', cellStyle: { width: 160 } },
    ),
};

export const Disabled: Story = {
  render: () =>
    renderMatrix(VARIANTS, ['enabled', 'disabled'] as const, (variant, state) => (
      <Button variant={variant} disabled={state === 'disabled'}>
        Grant
      </Button>
    )),
};

/** `inv` = current/inverted (chosen Accept in diff review); `on` = accent/armed. Attributes only set when true. */
export const States: Story = {
  render: () =>
    renderMatrix(VARIANTS, ['default', 'inv', 'on'] as const, (variant, state) => (
      <Button variant={variant} inv={state === 'inv'} on={state === 'on'}>
        Accept
      </Button>
    )),
};

export const Inverted: Story = { args: { inv: true, children: 'Accept' } };
export const Armed: Story = { args: { on: true, children: 'Grant' } };

/** Grant sheet footer row: ghost Deny (flex 1) next to accent Grant (flex 1.4). */
export const FooterRow: Story = {
  render: () => (
    <div style={{ display: 'flex', width: 360, borderTop: '1px solid var(--ln)' }}>
      <Button size="footer" variant="ghost">
        Deny
      </Button>
      <Button size="footer" variant="accent" grow={1.4}>
        Grant · 1h
      </Button>
    </div>
  ),
};

/** Same matrix on the `--s1` surface (sidebars, sheets) to check hairlines. */
export const OnSurfaceS1: Story = {
  decorators: [withSurface('s1')],
  render: () =>
    renderMatrix(VARIANTS, ['compact', 'regular'] as const, (variant, size) => (
      <Button variant={variant} size={size}>
        {variant}
      </Button>
    )),
};
