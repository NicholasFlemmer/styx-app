import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Label } from './Label';

describe('Label', () => {
  it('renders a span by default', () => {
    render(<Label>Duration</Label>);
    expect(screen.getByText('Duration').tagName).toBe('SPAN');
  });
  it('renders the requested element and htmlFor', () => {
    render(
      <>
        <Label as="label" htmlFor="f">Secret</Label>
        <input id="f" />
      </>,
    );
    expect(screen.getByLabelText('Secret')).toHaveAttribute('id', 'f');
    expect(screen.getByText('Secret').tagName).toBe('LABEL');
  });
  it('drops htmlFor on non-label elements', () => {
    render(<Label as="h2" htmlFor="x">Files</Label>);
    expect(screen.getByRole('heading', { name: 'Files' })).not.toHaveAttribute('for');
  });
  it('sets data-inv/data-on only when true', () => {
    render(<Label inv strong>Inbox</Label>);
    const el = screen.getByText('Inbox');
    expect(el).toHaveAttribute('data-inv', 'true');
    expect(el).not.toHaveAttribute('data-on');
  });
});
