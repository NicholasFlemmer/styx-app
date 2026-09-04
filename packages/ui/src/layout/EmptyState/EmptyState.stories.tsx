import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmptyState } from './EmptyState';
import { Button } from '../../primitives/Button';

const meta = {
  title: 'Layout/EmptyState',
  component: EmptyState,
  args: {
    headline: 'No projects yet.',
    body: "Start something new, add a folder, or clone a repo. Agents and targets attach to projects, so Styx asks about those when they're first needed.",
    actions: (
      <>
        <Button variant="primary">Scan this machine</Button>
        <Button>New project</Button>
        <Button>Open folder</Button>
        <Button>Clone URL</Button>
      </>
    ),
  },
  decorators: [(Story) => <div style={{ width: 980 }}><Story /></div>],
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NoProjects: Story = {};
export const HeadlineOnly: Story = { args: { body: undefined, actions: undefined } };
export const NoActions: Story = { args: { actions: undefined } };

export const Matrix: Story = {
  render: (a) => (
    <div>
      <EmptyState {...a} />
      <EmptyState {...a} headline="Nothing needs you." body="Agents are working. You'll be told the moment one needs a decision." actions={undefined} />
    </div>
  ),
};
