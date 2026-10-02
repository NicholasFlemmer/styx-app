import { AGENT_LABEL, copy, fill, type Agent, type DesignTokens } from '@styx/core';
import { Button, Textarea } from '@styx/ui';
import { useId, useState } from 'react';
import { elementName, type CanvasSelection } from './design-doc';
import s from './DesignCanvas.module.css';

const CORNERS = [0, 4, 8, 12, 16, 24, 999];

/** Hand edits change the frame's own document, which then saves; kept out of render so the edit is plainly a side effect. */
const setElementText = (el: Element, text: string) => {
  el.textContent = text;
};

/** A stable key per picked element, so its fields start from that element's values. */
const keys = new WeakMap<Element, number>();
let nextKey = 1;
export const selectionKey = (sel: CanvasSelection): string => {
  const el = sel.kind === 'element' ? sel.el : sel.els[0];
  if (el === undefined) return `${sel.file.path}:area`;
  let k = keys.get(el);
  if (k === undefined) {
    k = nextKey++;
    keys.set(el, k);
  }
  return `${sel.file.path}:${sel.kind}:${k}:${sel.kind === 'area' ? `${sel.rect.x},${sel.rect.y}` : ''}`;
};

export interface SelectionPanelProps {
  selection: CanvasSelection;
  tokens: DesignTokens | null;
  agent: Agent;
  busy: boolean;
  onEdited: () => void;
  onSend: (text: string) => void;
}

/** What an element is and the few things worth changing by hand: text, fill, colour, type, corners. */
function ElementFields({
  el,
  tokens,
  onEdited,
}: {
  el: Element;
  tokens: DesignTokens | null;
  onEdited: () => void;
}) {
  const ids = { text: useId(), fill: useId(), colour: useId(), type: useId(), corners: useId() };
  const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
  const leaf = el.children.length === 0;
  const [text, setText] = useState(leaf ? (el.textContent ?? '') : '');
  const colours = tokens?.colors ?? [];
  const scale = tokens?.scale ?? [];
  const set = (fn: (st: CSSStyleDeclaration) => void) => {
    if (style === undefined) return;
    fn(style);
    onEdited();
  };
  const current = (prop: string) => style?.getPropertyValue(prop) ?? '';
  const swatchFor = (value: string, prop: 'background' | 'color') => (
    <div
      className={s['swatches']}
      role="radiogroup"
      aria-labelledby={prop === 'background' ? ids.fill : ids.colour}
    >
      <button
        type="button"
        role="radio"
        aria-checked={current(prop) === ''}
        className={s['swatchNone']}
        title={copy.chat.design.element.none}
        onClick={() => set((st) => st.removeProperty(prop))}
      />
      {colours.map((c) => (
        <button
          key={c.name}
          type="button"
          role="radio"
          aria-checked={value === `var(--color-${c.name})`}
          aria-label={c.name}
          title={`${c.name} ${c.value}`}
          className={s['swatch']}
          style={{ background: c.value }}
          data-on={value === `var(--color-${c.name})` ? 'true' : undefined}
          onClick={() => set((st) => st.setProperty(prop, `var(--color-${c.name})`))}
        />
      ))}
    </div>
  );
  return (
    <>
      {leaf ? (
        <label className={s['field']} htmlFor={ids.text}>
          <span>{copy.chat.design.element.text}</span>
          <input
            id={ids.text}
            className={s['input']}
            value={text}
            onChange={(e) => {
              setText(e.currentTarget.value);
              setElementText(el, e.currentTarget.value);
              onEdited();
            }}
            data-design-text="true"
          />
        </label>
      ) : null}
      <div className={s['field']}>
        <span id={ids.fill}>{copy.chat.design.element.fill}</span>
        {swatchFor(current('background'), 'background')}
      </div>
      <div className={s['field']}>
        <span id={ids.colour}>{copy.chat.design.element.colour}</span>
        {swatchFor(current('color'), 'color')}
      </div>
      {scale.length > 0 ? (
        <label className={s['field']} htmlFor={ids.type}>
          <span>{copy.chat.design.element.type}</span>
          <select
            id={ids.type}
            className={s['input']}
            value={scale.find((x) => current('font-size') === `var(--text-${x.name}-size)`)?.name ?? ''}
            onChange={(e) => {
              const name = e.currentTarget.value;
              set((st) => {
                if (name === '') {
                  st.removeProperty('font-size');
                  st.removeProperty('line-height');
                  st.removeProperty('font-weight');
                  return;
                }
                st.setProperty('font-size', `var(--text-${name}-size)`);
                st.setProperty('line-height', `var(--text-${name}-line)`);
                st.setProperty('font-weight', `var(--text-${name}-weight)`);
              });
            }}
          >
            <option value="">{copy.chat.design.element.none}</option>
            {scale.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name} · {x.size}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className={s['field']} htmlFor={ids.corners}>
        <span>{copy.chat.design.element.corners}</span>
        <select
          id={ids.corners}
          className={s['input']}
          value={current('border-radius').replace('px', '')}
          onChange={(e) => {
            const v = e.currentTarget.value;
            set((st) =>
              v === '' ? st.removeProperty('border-radius') : st.setProperty('border-radius', `${v}px`),
            );
          }}
        >
          <option value="">{copy.chat.design.element.none}</option>
          {CORNERS.map((c) => (
            <option key={c} value={String(c)}>
              {c} px
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

/** The right panel with a selection: the element's fields or the area's contents, then Tell the agent. */
export function SelectionPanel({ selection, tokens, agent, busy, onEdited, onSend }: SelectionPanelProps) {
  const [text, setText] = useState('');
  const tellId = useId();
  const name = AGENT_LABEL[agent];
  const d = copy.chat.design;
  const send = () => {
    if (text.trim() === '' || busy) return;
    onSend(text.trim());
    setText('');
  };
  return (
    <div className={s['inspector']} data-design-inspector={selection.kind}>
      <section className={s['sec']}>
        <div className={s['secHead']}>
          <b>{selection.kind === 'element' ? elementName(selection.el) : d.area.title}</b>
          <span>
            {selection.file.screen} · {d.size[selection.file.size]}
          </span>
        </div>
        {selection.kind === 'element' ? (
          <ElementFields el={selection.el} tokens={tokens} onEdited={onEdited} />
        ) : (
          <>
            <div className={s['field']}>
              <span>{d.area.size}</span>
              <span className={s['value']}>
                {Math.round(selection.rect.width)} × {Math.round(selection.rect.height)}
              </span>
            </div>
            <div className={s['field']}>
              <span>{d.area.holds}</span>
              <span className={s['value']}>{selection.els.map(elementName).join(', ') || '—'}</span>
            </div>
          </>
        )}
      </section>
      <section className={s['sec']}>
        <label className={s['secHead']} htmlFor={tellId}>
          <b>{fill(d.tell, { agent: name })}</b>
          <span>⌘⏎</span>
        </label>
        <Textarea
          id={tellId}
          className={s['tell']}
          minHeight={64}
          placeholder={d.tellPlaceholder}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              send();
            }
          }}
          data-design-tell="true"
        />
        <Button
          variant="accent"
          className={s['sendBtn'] ?? ''}
          disabled={text.trim() === '' || busy}
          onClick={send}
          data-design-send="true"
        >
          {fill(d.send, { agent: name })}
        </Button>
      </section>
      <p className={s['foot']}>
        {selection.kind === 'element' ? fill(d.element.apply, { agent: name }) : d.area.foot}
      </p>
    </div>
  );
}

export interface TokensPanelProps {
  tokens: DesignTokens | null;
  fallback: DesignTokens;
  onChange: (tokens: DesignTokens) => void;
}

/** Type and colour for every screen at once: colours, typefaces, the type scale, corners and spacing. */
export function TokensPanel({ tokens, fallback, onChange }: TokensPanelProps) {
  const t = copy.chat.design.tokens;
  const ids = { heading: useId(), body: useId(), radius: useId(), spacing: useId() };
  if (tokens === null)
    return (
      <div className={s['inspector']} data-design-inspector="tokens">
        <section className={s['sec']}>
          <div className={s['secHead']}>
            <b>{t.title}</b>
          </div>
          <p className={s['foot']}>{t.none}</p>
          <Button onClick={() => onChange(fallback)} data-design-tokens-use="true">
            {t.use}
          </Button>
        </section>
      </div>
    );
  const patch = (p: Partial<DesignTokens>) => onChange({ ...tokens, ...p });
  return (
    <div className={s['inspector']} data-design-inspector="tokens">
      <section className={s['sec']}>
        <div className={s['secHead']}>
          <b>{t.title}</b>
          <span>{t.scope}</span>
        </div>
        <div className={s['subHead']}>{t.colours}</div>
        {tokens.colors.map((c, i) => (
          <label key={c.name} className={s['colourRow']}>
            <input
              type="color"
              className={s['colourPick']}
              value={c.value.toLowerCase()}
              aria-label={c.name}
              onChange={(e) => {
                const value = e.currentTarget.value.toUpperCase();
                patch({ colors: tokens.colors.map((x, j) => (j === i ? { ...x, value } : x)) });
              }}
              data-design-colour={c.name}
            />
            <span>{c.name}</span>
            <span className={s['value']}>{c.value}</span>
          </label>
        ))}
      </section>
      <section className={s['sec']}>
        <div className={s['subHead']}>{t.typefaces}</div>
        <label className={s['field']} htmlFor={ids.heading}>
          <span>{t.heading}</span>
          <input
            id={ids.heading}
            className={s['input']}
            value={tokens.fonts.heading}
            onChange={(e) =>
              patch({ fonts: { ...tokens.fonts, heading: e.currentTarget.value || 'system-ui' } })
            }
          />
        </label>
        <label className={s['field']} htmlFor={ids.body}>
          <span>{t.body}</span>
          <input
            id={ids.body}
            className={s['input']}
            value={tokens.fonts.body}
            onChange={(e) =>
              patch({ fonts: { ...tokens.fonts, body: e.currentTarget.value || 'system-ui' } })
            }
          />
        </label>
      </section>
      <section className={s['sec']}>
        <div className={s['subHead']}>{t.scale}</div>
        {tokens.scale.map((x, i) => (
          <div key={x.name} className={s['scaleRow']}>
            <span style={{ fontSize: Math.min(22, x.size), fontWeight: x.weight }}>{x.name}</span>
            <input
              type="number"
              min={8}
              max={160}
              className={s['num']}
              aria-label={`${x.name} size`}
              value={x.size}
              onChange={(e) => {
                const size = Math.max(8, Math.min(160, Number(e.currentTarget.value) || x.size));
                patch({
                  scale: tokens.scale.map((y, j) =>
                    j === i ? { ...y, size, line: Math.max(size, Math.round(size * (y.line / y.size))) } : y,
                  ),
                });
              }}
            />
          </div>
        ))}
      </section>
      <section className={s['sec']}>
        <label className={s['field']} htmlFor={ids.radius}>
          <span>{t.corners}</span>
          <input
            id={ids.radius}
            type="number"
            min={0}
            max={64}
            className={s['num']}
            value={tokens.radius}
            onChange={(e) => patch({ radius: Math.max(0, Math.min(64, Number(e.currentTarget.value) || 0)) })}
          />
        </label>
        <label className={s['field']} htmlFor={ids.spacing}>
          <span>{t.spacing}</span>
          <input
            id={ids.spacing}
            type="number"
            min={1}
            max={32}
            className={s['num']}
            value={tokens.spacing}
            onChange={(e) =>
              patch({ spacing: Math.max(1, Math.min(32, Number(e.currentTarget.value) || 4)) })
            }
          />
        </label>
      </section>
      <p className={s['foot']}>{t.foot}</p>
    </div>
  );
}
