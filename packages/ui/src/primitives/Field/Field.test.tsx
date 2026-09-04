import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field } from './Field';

describe('Field', () => {
  it('labels the control via htmlFor', () => {
    render(
      <Field label="Host" htmlFor="host">
        <input id="host" />
      </Field>,
    );
    expect(screen.getByLabelText('Host')).toHaveAttribute('id', 'host');
  });
  it('renders a span label when no htmlFor', () => {
    render(<Field label="Environment"><span>chips</span></Field>);
    expect(screen.getByText('Environment').tagName).toBe('SPAN');
  });
  it('renders the hint', () => {
    render(<Field label="a" hint="helper text"><input aria-label="a" /></Field>);
    expect(screen.getByText('helper text')).toBeInTheDocument();
  });
});
