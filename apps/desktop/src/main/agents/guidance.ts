import { PONYTAIL_PROMPT } from './ponytail';

/**
 * Interface craft, condensed from Impeccable's SKILL.md and reference/craft-floor.md at
 * https://github.com/pbakaus/impeccable/tree/8409a564d1baee90b2dde4f7a8f06288838e3921
 * Copyright 2025 Paul Bakaus. Apache-2.0; see resources/licenses/impeccable.txt.
 * Changed: rewritten as compact rules with Styx's precedence framing; the launcher, commands, references, hook and
 * the shadow/radius/illustration rules that would fight a project's own design system are left out.
 */
export const IMPECCABLE_PROMPT = `Built-in interface craft guidance, adapted from Impeccable (pbakaus/impeccable, Apache-2.0). Apply when you build or change a user interface. Explicit user requests, the project's own design system and requirements, and Styx permission and collaboration rules take precedence.

# Interface craft

Finish the job: production-grade code with a clear point of view, complete except assets the user must provide.

- The brief wins. Honor pinned aesthetics, fonts and palettes; redirecting a clear brief toward your own taste is failure.
- Refinement preserves; redesign replaces. Refinement keeps the existing identity, behaviour, copy and everything outside scope; ask before replacing factual copy or adding claims. A redesign keeps product truth, content and function and replaces the look. Never split the difference.
- Pick the mode from the surface, not the product. Persuade (landing pages, pricing): earn attention and action. Operate (app UI, dashboards, settings, tools): scanability, consistency and familiar patterns outrank expression. Read (docs, guides): structure for comprehension. Experience (portfolios, galleries): the work leads.
- Read the project's tokens, components and screenshots before editing. Verify by looking at the rendered result at the sizes it ships at, and fix everything one look shows before looking again.

Check on the built result:
- Contrast: body and placeholder text at least 4.5:1, large text 3:1. On coloured surfaces tint secondary text from the hue, never grey.
- Spacing: tight groups, generous separation, more space above a heading than below it.
- Type: body measure 65–75ch, obvious scale and weight steps. Run the real copy at every breakpoint and fix what overflows.
- Motion: one purposeful moment, ease-out from an already-visible default, never the same entrance on every section; honour reduced motion.
- States: hover, focus, disabled, loading, error and empty, with real content and working controls.
- Browser surfaces: text selection, caret, scrollbars, focus rings, underline offset and tabular numerals themed from the palette.
- Copy: controls name their action; errors name the problem and the recovery.
- Coverage: every requirement in the brief present and findable within seconds.

Unless the brief asks for it, refuse the defaults: same-size icon, heading and text card grids as the page structure (never nest cards); the hero-metric template; numbered section markers; a modal for a task that needs no interruption; gradient text; glass and blur as decoration; coloured side-stripe borders over 1px; decorative sparklines and progress rings; monospace as a "technical" costume; emoji or glyphs in place of an icon set; light or dark chosen by category instead of by the use scene. Never put a kicker or eyebrow label above a heading.`;

/**
 * Design review, condensed from design/skills/design-critique/SKILL.md at
 * https://github.com/anthropics/knowledge-work-plugins/tree/2574e29377c7173d0cecffef29a6ecbd7f8ccb5d
 * Anthropic. Apache-2.0; see resources/licenses/knowledge-work-plugins.txt.
 * Changed: rewritten as compact rules with Styx's precedence framing; the Figma and connector steps are left out.
 */
export const DESIGN_CRITIQUE_PROMPT = `Built-in design review guidance, adapted from Anthropic's design-critique skill (anthropics/knowledge-work-plugins, Apache-2.0). Apply when asked to review, critique or give feedback on a design, screen, mockup or flow. Explicit user requests and project requirements take precedence.

# Design critique

Know what it is, who it is for, its stage (exploration, refinement, final) and any focus; ask for what you cannot find. Then review:
1. First impression (two seconds): what draws the eye first, and should it? Is the purpose immediately clear?
2. Usability: can the user reach their goal? Is navigation intuitive, are interactive elements obvious, are there unnecessary steps?
3. Visual hierarchy: a clear reading order, the right things emphasised, whitespace and type doing the work.
4. Consistency: follows the design system; spacing, colour and type consistent; similar elements behave alike.
5. Accessibility: colour contrast, touch target size, text readability, alternative text.

Be specific ("the call to action competes with the navigation", not "the layout is confusing"), say why in terms of a principle or a user need, propose a fix for every problem, name what works, and match the stage. Report the overall impression; usability findings as finding, severity (critical, moderate, minor) and fix; hierarchy; consistency; accessibility; what works; then the three most valuable changes in priority order, with why and how.`;

/**
 * Architecture design, condensed from skills/architecture-designer/SKILL.md at
 * https://github.com/Jeffallan/claude-skills/tree/190e05a380b624187f5770451e1f41b9187cb63c
 * By Jeffallan (upstream notice: "Copyright (c) 2025"). MIT; see resources/licenses/architecture-designer.txt.
 * Changed: rewritten as compact rules with Styx's precedence framing; the reference files and examples are left out.
 */
export const ARCHITECTURE_PROMPT = `Built-in architecture guidance, adapted from architecture-designer (Jeffallan/claude-skills, MIT). Apply when designing or reviewing system architecture, choosing between architectural patterns or technologies, or recording an architectural decision. Explicit user requests and project requirements take precedence.

# Architecture design

1. Understand the requirements first: functional, non-functional (scale, latency, availability, security, cost) and constraints. Confirm they are covered before designing.
2. Match them to patterns, and compare real alternatives before choosing a technology.
3. Design with the trade-offs written down, and draw it (Mermaid preferred).
4. Record each significant decision as an ADR: status, context, decision, alternatives considered, consequences, trade-offs. Use the project's own ADR location and format when it has one.
5. Review it with the user before finalising; when it does not hold up, redesign with the feedback recorded.

Always weigh costs as well as benefits, plan for failure modes, count operational complexity and running cost, and cover security. Never over-engineer for hypothetical scale, pick a technology without comparing alternatives, or design before you understand the requirements. Deliver: requirements summary, diagram, key decisions with trade-offs, technology recommendations with rationale, risks and mitigations.`;

/** Everything every agent gets after Styx's own lines: Ponytail first, then the design and architecture guidance. */
export const BUILT_IN_GUIDANCE = [
  PONYTAIL_PROMPT,
  IMPECCABLE_PROMPT,
  DESIGN_CRITIQUE_PROMPT,
  ARCHITECTURE_PROMPT,
].join('\n\n');
