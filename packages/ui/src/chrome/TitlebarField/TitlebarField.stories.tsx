import type { Meta, StoryObj } from '@storybook/react-vite';
import { TitlebarField } from './TitlebarField';

const meta = {
  title: 'Chrome/TitlebarField',
  component: TitlebarField,
  args: { platform: 'darwin', onClick: () => {} },
  decorators: [(Story) => <div style={{ background: 'var(--s1)', padding: 12 }}><Story /></div>],
} satisfies Meta<typeof TitlebarField>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Mac: Story = {};
export const Windows: Story = { args: { platform: 'win32' } };
export const CustomPlaceholder: Story = { args: { placeholder: 'Jump to…', hint: '⌘P' } };

export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 12, justifyContent: 'start' }}>
      <TitlebarField platform="darwin" />
      <TitlebarField platform="win32" />
      <TitlebarField platform="darwin" inv />
    </div>
  ),
};
