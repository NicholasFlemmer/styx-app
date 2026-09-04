import type { Meta, StoryObj } from '@storybook/react-vite';
import { Titlebar } from './Titlebar';
import { Wordmark } from '../Wordmark';
import { TitlebarCounter } from '../TitlebarCounter';
import { TitlebarField } from '../TitlebarField';
import { Button } from '../../primitives/Button';

const left = (
  <>
    <Wordmark />
    <span style={{ width: 1, height: 16, background: 'var(--ln)' }} />
    <Button style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13, background: 'var(--bg)' }}>acme-shop ▾</Button>
    <span className="t-meta" style={{ fontSize: 12 }}>fix/checkout</span>
  </>
);
const right = (platform: 'darwin' | 'win32') => (
  <>
    <TitlebarField platform={platform} onClick={() => {}} />
    <TitlebarCounter count={2} label="needs you" tone="accent" live />
    <TitlebarCounter count={1} label="locked" tone="hollowStrong" />
  </>
);

const meta = {
  title: 'Chrome/Titlebar',
  component: Titlebar,
  args: { platform: 'darwin', left, right: right('darwin') },
  decorators: [(Story) => <div style={{ width: 1100 }}><Story /></div>],
} satisfies Meta<typeof Titlebar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Mac: Story = {};
export const Windows: Story = { args: { platform: 'win32', right: right('win32') } };
export const LeftOnly: Story = { args: { right: undefined } };

export const Matrix: Story = {
  render: (a) => (
    <div style={{ display: 'grid', gap: 16 }}>
      <Titlebar {...a} platform="darwin" asLandmark={false} />
      <Titlebar {...a} platform="win32" right={right('win32')} asLandmark={false} />
    </div>
  ),
};
