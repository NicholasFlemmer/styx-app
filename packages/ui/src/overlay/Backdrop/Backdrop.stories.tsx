import type { Meta, StoryObj } from '@storybook/react-vite';
import { Backdrop } from './Backdrop';

const meta = {
  title: 'Overlay/Backdrop',
  component: Backdrop,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ position: 'relative', width: 900, height: 480, background: 'var(--bg)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Backdrop>;
export default meta;
type Story = StoryObj<typeof meta>;

const panel = (
  <div style={{ width: 320, border: '1px solid var(--tx)', background: 'var(--s1)', padding: 16 }}>
    Panel (clicks inside do not close)
  </div>
);

export const Modal: Story = { args: { paddingTop: 90, children: panel } };
export const Palette: Story = { args: { paddingTop: 110, children: panel } };
export const Matrix: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 }}>
      {[90, 110].map((pt) => (
        <div key={pt} style={{ position: 'relative', height: 300, border: '1px solid var(--ln)' }}>
          <Backdrop paddingTop={pt}>{panel}</Backdrop>
        </div>
      ))}
    </div>
  ),
};
