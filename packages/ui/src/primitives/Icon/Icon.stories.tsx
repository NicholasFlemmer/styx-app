import type { Meta, StoryObj } from '@storybook/react-vite';
import { renderMatrix } from '../../storybook/matrix';
import { ICON_NAMES, Icon } from './Icon';

/** Every icon: the chrome glyphs first, then the navigation set (app rail, project nav). */
const NAMES = ICON_NAMES;

const meta = {
  title: 'Primitives/Icon',
  component: Icon,
  args: { name: 'chevron' },
  argTypes: {
    name: { control: 'select', options: NAMES },
    size: { control: 'number' },
  },
} satisfies Meta<typeof Icon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** All chrome glyphs at native size; colour comes from `currentColor`. */
export const All: Story = {
  render: () =>
    renderMatrix(NAMES, ['native', '12', '16', '20'] as const, (name, size) => (
      <Icon name={name} {...(size === 'native' ? {} : { size: Number(size) })} />
    )),
};

/** Inherits colour from the surrounding text: `--tx`, `--mu`, `--ac`. */
export const Colours: Story = {
  render: () =>
    renderMatrix(
      NAMES,
      [
        { label: 'tx', value: 'var(--tx)' },
        { label: 'mu', value: 'var(--mu)' },
        { label: 'ac', value: 'var(--ac)' },
      ],
      (name, color) => (
        <span style={{ color, display: 'inline-flex' }}>
          <Icon name={name} />
        </span>
      ),
    ),
};
