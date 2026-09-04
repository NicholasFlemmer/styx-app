import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Message } from './Message';

afterEach(cleanup);

describe('Message', () => {
  it('renders each kind with its data-kind', () => {
    const { container } = render(
      <>
        <Message kind="user" text="hi" />
        <Message kind="agent">plan</Message>
        <Message kind="system" text="grant: x" />
        <Message kind="fileList" files={[{ path: 'a.ts', added: 3 }]} />
      </>,
    );
    const kinds = Array.from(container.querySelectorAll('[data-kind]')).map((el) =>
      el.getAttribute('data-kind'),
    );
    expect(kinds).toEqual(['user', 'agent', 'system', 'fileList']);
  });

  it('file list shows +added in accent and −removed', () => {
    render(
      <Message
        kind="fileList"
        files={[
          { path: 'validate.ts', added: 31 },
          { path: 'checkout.ts', added: 2, removed: 0 },
        ]}
      />,
    );
    expect(screen.getByText('validate.ts').nextElementSibling).toHaveTextContent('+31');
    expect(screen.getByText('checkout.ts').nextElementSibling).toHaveTextContent('+2 −0');
  });

  it('decision options call onChoose with the label; first is primary', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    render(
      <Message kind="decision" options={[{ label: 'Yes' }, { label: 'No' }]} onChoose={onChoose}>
        Open a PR?
      </Message>,
    );
    const yes = screen.getByRole('button', { name: 'Yes' });
    const no = screen.getByRole('button', { name: 'No' });
    expect(yes.className).toMatch(/primary/);
    expect(no.className).not.toMatch(/primary/);
    await user.click(no);
    expect(onChoose).toHaveBeenCalledWith('No');
  });

  it('access request header and body copy; actions call back', async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    const onDeny = vi.fn();
    render(
      <Message
        kind="accessRequest"
        target="Supabase"
        env="prod"
        scopes={['read schema', 'write']}
        onReview={onReview}
        onDeny={onDeny}
      />,
    );
    expect(screen.getByText('Access request · Supabase prod')).toBeInTheDocument();
    expect(
      screen.getByText('Scope: read schema, write. No grant on file for this target.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review request' }));
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('compact adds the compact class', () => {
    render(<Message kind="user" text="x" compact />);
    expect(screen.getByText('x').className).toMatch(/compact/);
  });
});
