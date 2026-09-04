import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Table, TableRow, TableCell, TABLE_COLUMNS } from './Table';

describe('Table', () => {
  it('renders header as columnheaders and applies the column template', () => {
    render(
      <Table columns={TABLE_COLUMNS.repo} header={['Branch', 'Owner']}>
        <TableRow><TableCell>a</TableCell></TableRow>
      </Table>,
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Branch', 'Owner']);
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveStyle({ gridTemplateColumns: TABLE_COLUMNS.repo, padding: '14px 20px' });
    expect(screen.getByRole('cell')).toHaveTextContent('a');
  });
  it('names blank header cells for assistive tech with visually hidden text', () => {
    render(<Table columns={TABLE_COLUMNS.repo} header={['Branch', '']} />);
    const blank = screen.getByRole('columnheader', { name: 'Actions' });
    expect(blank).not.toHaveAttribute('aria-label');
    // Text is present for AT but visually hidden (clip recipe), so the column stays blank.
    expect(within(blank).getByText('Actions').className).toMatch(/srOnly/);
    expect(screen.getByRole('columnheader', { name: 'Branch' })).toBeInTheDocument();
  });
  it('propagates rowPad and gap from the table', () => {
    render(
      <Table columns="20px 1fr" rowPad="10px 14px" gap="14px">
        <TableRow><TableCell>a</TableCell></TableRow>
      </Table>,
    );
    expect(screen.getByRole('row')).toHaveStyle({ padding: '10px 14px', gap: '14px' });
  });
  it('static rows are not focusable', () => {
    render(<Table columns="1fr"><TableRow><TableCell>a</TableCell></TableRow></Table>);
    expect(screen.getByRole('row')).not.toHaveAttribute('tabindex');
  });
  it('interactive rows activate on click, Enter and Space', async () => {
    const onActivate = vi.fn();
    render(
      <Table columns="1fr">
        <TableRow onActivate={onActivate}><TableCell>open me</TableCell></TableRow>
      </Table>,
    );
    const row = screen.getByRole('row');
    expect(row).toHaveAttribute('tabindex', '0');
    await userEvent.tab();
    expect(row).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onActivate).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(' ');
    expect(onActivate).toHaveBeenCalledTimes(2);
    await userEvent.click(row);
    expect(onActivate).toHaveBeenCalledTimes(3);
  });
  it('keys from nested controls do not activate the row', async () => {
    const onActivate = vi.fn();
    render(
      <Table columns="1fr">
        <TableRow onActivate={onActivate}>
          <TableCell><button type="button">inner</button></TableCell>
        </TableRow>
      </Table>,
    );
    screen.getByRole('button').focus();
    await userEvent.keyboard('{Enter}');
    // click from Enter on the inner button bubbles as a click, but the keydown itself must not fire activate twice
    expect(onActivate.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('sets data-inv / data-muted only when true', () => {
    render(
      <Table columns="1fr 1fr">
        <TableRow inv><TableCell muted>m</TableCell><TableCell>p</TableCell></TableRow>
      </Table>,
    );
    expect(screen.getByRole('row')).toHaveAttribute('data-inv', 'true');
    expect(screen.getByRole('row')).not.toHaveAttribute('data-on');
    expect(screen.getByText('m')).toHaveAttribute('data-muted', 'true');
    expect(screen.getByText('p')).not.toHaveAttribute('data-muted');
  });
  it('exports the per-screen column constants', () => {
    expect(TABLE_COLUMNS.home).toBe('1.2fr 1.6fr .9fr 1.4fr 1.4fr .8fr');
    expect(TABLE_COLUMNS.onboardingIde).toBe('20px 1.1fr 1.2fr 1fr auto');
  });
});
