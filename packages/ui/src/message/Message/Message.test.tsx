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

  it('settled decision: options disabled, the chosen one inverted, nothing fires', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    render(
      <Message
        kind="decision"
        options={[{ label: 'Allow' }, { label: 'Deny' }]}
        onChoose={onChoose}
        chosen="Deny"
      >
        Run pnpm test?
      </Message>,
    );
    const allow = screen.getByRole('button', { name: 'Allow' });
    const deny = screen.getByRole('button', { name: 'Deny' });
    expect(allow).toBeDisabled();
    expect(deny).toBeDisabled();
    expect(deny.getAttribute('data-inv')).toBe('true');
    expect(allow.getAttribute('data-inv')).toBeNull();
    expect(
      screen.getByText('Run pnpm test?').closest('[data-kind="decision"]')?.getAttribute('data-settled'),
    ).toBe('true');
    await user.click(allow);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('closed decision (disabled, no choice): options disabled, none inverted', () => {
    render(
      <Message kind="decision" options={[{ label: 'Allow' }, { label: 'Deny' }]} onChoose={() => {}} disabled>
        Run pnpm test?
      </Message>,
    );
    for (const b of screen.getAllByRole('button')) {
      expect(b).toBeDisabled();
      expect(b.getAttribute('data-inv')).toBeNull();
    }
  });

  it('tool row: glyph (hidden from AT), tool name, hint with title, optional detail; error status flagged', () => {
    const { container, rerender } = render(
      <Message kind="tool" tool="Bash" hint="pnpm test -F @styx/core" status="running" statusGlyph="…" />,
    );
    const row = container.querySelector('[data-kind="tool"]');
    expect(row?.getAttribute('data-status')).toBe('running');
    expect(row?.querySelector('[aria-hidden="true"]')?.textContent).toBe('…');
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('pnpm test -F @styx/core').getAttribute('title')).toBe('pnpm test -F @styx/core');
    expect(row?.childElementCount).toBe(1);
    rerender(
      <Message
        kind="tool"
        tool="Bash"
        hint="pnpm typecheck"
        status="error"
        statusGlyph="×"
        detail="TS2322: no"
      />,
    );
    expect(container.querySelector('[data-kind="tool"]')?.getAttribute('data-status')).toBe('error');
    expect(screen.getByText('TS2322: no')).toBeInTheDocument();
    expect(container.querySelector('[data-kind="tool"]')?.childElementCount).toBe(2);
  });

  it('access request header and body copy; actions call back', async () => {
    const user = userEvent.setup();
    const onReview = vi.fn();
    const onDeny = vi.fn();
    render(
      <Message
        kind="accessRequest"
        header="Access request · Supabase prod"
        body="Scope: read schema, write. No grant on file for this target."
        reviewLabel="Review request"
        denyLabel="Deny"
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

  it('agent: streaming appends a hidden blinking cursor; settled bubbles have none', () => {
    const { container, rerender } = render(
      <Message kind="agent" streaming>
        Reading
      </Message>,
    );
    const bubble = container.querySelector('[data-kind="agent"]');
    expect(bubble?.getAttribute('data-streaming')).toBe('true');
    const cursor = bubble?.querySelector('[aria-hidden="true"]');
    expect(cursor?.textContent).toBe('▌');
    expect(cursor?.className).toMatch(/cursor/);
    rerender(<Message kind="agent">Reading</Message>);
    expect(container.querySelector('[data-kind="agent"]')?.getAttribute('data-streaming')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('thinking (streaming): label, open body with a cursor, no toggle', () => {
    const { container } = render(
      <Message
        kind="thinking"
        status="streaming"
        text="Checking pay.ts"
        label="Thinking…"
        showLabel="Show"
        hideLabel="Hide"
      />,
    );
    const block = container.querySelector('[data-kind="thinking"]');
    expect(block?.getAttribute('data-status')).toBe('streaming');
    expect(block?.getAttribute('data-open')).toBe('true');
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
    expect(screen.getByText('Checking pay.ts')).toBeInTheDocument();
    expect(block?.querySelector('[aria-hidden="true"]')?.textContent).toBe('▌');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('thinking (done): collapsed by default; Show/Hide toggles the body with aria-expanded/controls; no cursor', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Message
        kind="thinking"
        status="done"
        text="Checking pay.ts"
        label="Thought for 4s"
        showLabel="Show"
        hideLabel="Hide"
      />,
    );
    const block = container.querySelector('[data-kind="thinking"]');
    expect(block?.getAttribute('data-open')).toBeNull();
    expect(screen.getByText('Thought for 4s')).toBeInTheDocument();
    expect(screen.queryByText('Checking pay.ts')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    const body = screen.getByText('Checking pay.ts');
    expect(body.id).toBe(toggle.getAttribute('aria-controls'));
    expect(screen.getByRole('button', { name: 'Hide' }).getAttribute('aria-expanded')).toBe('true');
    expect(block?.getAttribute('data-open')).toBe('true');
    expect(block?.querySelector('[aria-hidden="true"]')).toBeNull();
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByText('Checking pay.ts')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show' })).toHaveFocus();
  });

  it('thinking (done, defaultOpen): starts expanded with Hide', () => {
    render(
      <Message
        kind="thinking"
        status="done"
        text="Checking pay.ts"
        label="Thought for 4s"
        showLabel="Show"
        hideLabel="Hide"
        defaultOpen
      />,
    );
    expect(screen.getByText('Checking pay.ts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('compact adds the compact class', () => {
    render(<Message kind="user" text="x" compact />);
    expect(screen.getByText('x').className).toMatch(/compact/);
  });
});
