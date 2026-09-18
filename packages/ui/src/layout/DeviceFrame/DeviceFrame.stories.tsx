import type { Meta, StoryObj } from '@storybook/react-vite';
import { renderMatrix } from '../../storybook/matrix';
import { DeviceFrame, type DeviceFrameKind } from './DeviceFrame';

/** Stand-in for the page: fills the screen slot and says how big it is. */
const Screen = ({ width, height }: { width: number; height: number }) => (
  <div
    className="t-label"
    style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--s2)',
      color: 'var(--tx)',
    }}
  >
    {width} × {height}
  </div>
);

const meta = {
  title: 'Layout/DeviceFrame',
  component: DeviceFrame,
  args: { kind: 'phone', width: 393, height: 852, label: 'Phone frame' },
  argTypes: { kind: { control: 'inline-radio', options: ['phone', 'tablet'] } },
  render: (a) => (
    <DeviceFrame {...a}>
      <Screen width={a.width} height={a.height} />
    </DeviceFrame>
  ),
} satisfies Meta<typeof DeviceFrame>;
export default meta;
type Story = StoryObj<typeof meta>;

/** iPhone 14 Pro viewport (the phone preset). */
export const Phone: Story = {};
export const PhoneLandscape: Story = { args: { landscape: true, width: 852, height: 393 } };
/** iPad Air viewport (the tablet preset). */
export const Tablet: Story = { args: { kind: 'tablet', width: 834, height: 1112, label: 'Tablet frame' } };
export const TabletLandscape: Story = {
  args: { kind: 'tablet', landscape: true, width: 1112, height: 834, label: 'Tablet frame' },
};
/** A mirrored simulator: the frame takes the device's own screen size, here at half scale like the pane does. */
export const Scaled: Story = {
  args: { label: 'iPhone 17 Pro frame', width: 402, height: 874 },
  render: (a) => (
    <div style={{ width: 240, height: 500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <DeviceFrame {...a} style={{ transform: 'scale(0.5)' }}>
        <Screen width={a.width} height={a.height} />
      </DeviceFrame>
    </div>
  ),
};

const kinds: DeviceFrameKind[] = ['phone', 'tablet'];
/** Kind × orientation at a small screen size so the whole matrix fits one canvas. */
export const Matrix: Story = {
  render: () =>
    renderMatrix(
      kinds,
      [
        { label: 'portrait', value: false },
        { label: 'landscape', value: true },
      ],
      (kind, landscape) => {
        const w = kind === 'phone' ? 120 : 200;
        const h = kind === 'phone' ? 260 : 267;
        const width = landscape ? h : w;
        const height = landscape ? w : h;
        return (
          <DeviceFrame
            kind={kind}
            landscape={landscape}
            width={width}
            height={height}
            label={`${kind} frame`}
          >
            <Screen width={width} height={height} />
          </DeviceFrame>
        );
      },
      { rowTitle: 'kind', colTitle: 'orientation' },
    ),
};
