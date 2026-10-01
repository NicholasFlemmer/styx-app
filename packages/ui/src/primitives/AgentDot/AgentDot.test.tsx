import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AgentDot } from './AgentDot';

describe('AgentDot', () => {
  it('is decoration: hidden from assistive technology, coloured by agent', () => {
    const { container } = render(<AgentDot agent="codex" />);
    const dot = container.querySelector('[data-agent]');
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot).toHaveAttribute('data-agent', 'codex');
  });
});
