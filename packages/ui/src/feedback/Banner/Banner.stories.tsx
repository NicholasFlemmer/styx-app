import type { Meta, StoryObj } from '@storybook/react-vite';
import { Banner, BannerStack } from './Banner';

const meta = {
  title: 'Feedback/Banner',
  component: Banner,
  args: {
    tone: 'error',
    text: 'AWS acme-prod: credentials expired 2h ago. Agents requesting it are paused.',
  },
  decorators: [(Story) => <div style={{ width: 980 }}><Story /></div>],
} satisfies Meta<typeof Banner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Error: Story = { args: { action: { label: 'Reconnect', onClick: () => {} }, onDismiss: () => {} } };
export const Info: Story = {
  args: { tone: 'info', text: 'Styx 0.2 is ready to install. Restart to update.', action: { label: 'Restart', onClick: () => {} }, onDismiss: () => {} },
};
export const NoAction: Story = { args: { onDismiss: () => {} } };
export const NoDismiss: Story = { args: { action: { label: 'Reconnect', onClick: () => {} } } };

export const Stack: Story = {
  render: (a) => (
    <BannerStack>
      <Banner {...a} action={{ label: 'Reconnect', onClick: () => {} }} onDismiss={() => {}} />
      <Banner {...a} tone="info" text="Claude Code CLI not found on PATH." action={{ label: 'Locate binary', onClick: () => {} }} onDismiss={() => {}} />
    </BannerStack>
  ),
};

export const Matrix: Story = {
  render: (a) => (
    <BannerStack>
      <Banner {...a} action={{ label: 'Reconnect', onClick: () => {} }} onDismiss={() => {}} />
      <Banner {...a} tone="info" text="info · with action + dismiss" action={{ label: 'Restart', onClick: () => {} }} onDismiss={() => {}} />
      <Banner {...a} tone="error" text="error · text only" />
      <Banner {...a} tone="info" text="info · dismiss only" onDismiss={() => {}} />
    </BannerStack>
  ),
};
