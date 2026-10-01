import s from './AgentDot.module.css';

/** The agents Styx runs; each has its own colour token (ADR-0027 §7). */
export type AgentKind = 'claude' | 'codex' | 'gemini' | 'cursor' | 'shell';

export interface AgentDotProps {
  agent: AgentKind;
  className?: string | undefined;
}

/**
 * The small square beside an agent's name (ADR-0027 §7). Decoration only: the name next to it carries the
 * meaning, so it is hidden from assistive technology.
 */
export function AgentDot({ agent, className }: AgentDotProps) {
  return (
    <span aria-hidden="true" className={[s['dot'], className].filter(Boolean).join(' ')} data-agent={agent} />
  );
}
