/**
 * Select to fix in the running app (#140). A script run in the Preview page: hover outlines the element under the
 * pointer, a click picks it, a drag picks every element inside the box, Escape cancels. It resolves with plain data
 * (never DOM) that `describePick` turns into the chip's label and the detail the agent gets.
 *
 * The page is the person's own dev server; what it returns is treated as untrusted text: parsed, clipped and only
 * ever shown or sent to the agent.
 */
import { z } from 'zod';

const pickedElementSchema = z.object({
  tag: z.string().max(40),
  id: z.string().max(80),
  classes: z.array(z.string().max(60)).max(6),
  text: z.string().max(200),
  html: z.string().max(1200),
  component: z.string().max(80),
  source: z.string().max(300),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});
export type PickedElement = z.infer<typeof pickedElementSchema>;

export const rawPickSchema = z.object({
  kind: z.enum(['element', 'area']),
  path: z.string().max(400),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  items: z.array(pickedElementSchema).max(16),
});
export type RawPick = z.infer<typeof rawPickSchema>;

const short = (e: PickedElement): string => {
  const name =
    e.id !== '' ? `${e.tag}#${e.id}` : e.classes[0] !== undefined ? `${e.tag}.${e.classes[0]}` : e.tag;
  const text = e.text.trim().replace(/\s+/g, ' ');
  return `${e.component !== '' ? `${e.component} › ` : ''}${name}${text !== '' ? ` “${text.slice(0, 40)}”` : ''}`;
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The chip's label and the agent's detail for a pick. */
export const describePick = (raw: RawPick): { label: string; detail: string } => {
  const w = Math.round(raw.rect.width);
  const h = Math.round(raw.rect.height);
  const first = raw.items[0];
  const label =
    raw.kind === 'element' && first !== undefined
      ? clip(short(first), 190)
      : clip(`Area ${w} × ${h}: ${raw.items.map(short).join(', ') || 'empty'}`, 190);
  const lines = [
    `Page: ${raw.path}`,
    raw.kind === 'element'
      ? `One element, ${w} × ${h} px at (${Math.round(raw.rect.x)}, ${Math.round(raw.rect.y)}).`
      : `An area ${w} × ${h} px at (${Math.round(raw.rect.x)}, ${Math.round(raw.rect.y)}) holding ${raw.items.length} element(s):`,
    ...raw.items.map((e, i) =>
      [
        `${i + 1}. ${short(e)}`,
        e.source !== '' ? `   source: ${e.source}` : '',
        `   markup: ${e.html.replace(/\s+/g, ' ')}`,
      ]
        .filter((l) => l !== '')
        .join('\n'),
    ),
    'A picture of it is attached.',
  ];
  return { label, detail: lines.join('\n') };
};

/** Cancels a pick in progress (the pending script resolves null). */
export const CANCEL_PICK_SCRIPT = 'window.__styxPickCancel ? (window.__styxPickCancel(), true) : false';

/** The pick, as a script string for `executeJavaScript` (resolves RawPick-shaped data or null). */
export const PICK_SCRIPT = `new Promise((resolve) => {
  if (window.__styxPickCancel) window.__styxPickCancel();
  const ACC = '#d6ff3d';
  const layer = document.createElement('div');
  layer.setAttribute('data-styx-pick', '');
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:transparent';
  const hover = document.createElement('div');
  hover.style.cssText = 'position:fixed;pointer-events:none;outline:2px solid ' + ACC + ';outline-offset:2px;display:none;z-index:2147483647';
  const tag = document.createElement('div');
  tag.style.cssText = 'position:fixed;pointer-events:none;background:' + ACC + ';color:#0d0e0c;font:700 11px/1 system-ui;padding:4px 6px;display:none;z-index:2147483647;white-space:nowrap';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;border:1.5px dashed ' + ACC + ';background:rgba(214,255,61,.1);display:none;z-index:2147483647';
  document.documentElement.append(layer, hover, tag, box);
  let start = null;
  const under = (x, y) => {
    layer.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    layer.style.pointerEvents = 'auto';
    return el && el !== document.documentElement && el !== document.body ? el : null;
  };
  const fiberOf = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$'));
    return k ? el[k] : null;
  };
  const component = (el) => {
    let f = fiberOf(el);
    while (f) {
      const t = f.type;
      if (typeof t === 'function' && (t.displayName || t.name)) return String(t.displayName || t.name);
      f = f.return;
    }
    return '';
  };
  const source = (el) => {
    for (const a of ['data-source', 'data-loc', 'data-inspector-relative-path', 'data-component-file']) {
      const v = el.closest('[' + a + ']');
      if (v) return String(v.getAttribute(a));
    }
    let f = fiberOf(el);
    while (f) {
      const s = f._debugSource;
      if (s && s.fileName) return s.fileName + ':' + s.lineNumber;
      f = f.return;
    }
    return '';
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase().slice(0, 40),
      id: (el.id || '').slice(0, 80),
      classes: Array.from(el.classList || []).slice(0, 6).map((c) => String(c).slice(0, 60)),
      text: (el.innerText || el.textContent || '').trim().slice(0, 200),
      html: el.outerHTML.slice(0, 1200),
      component: component(el).slice(0, 80),
      source: source(el).slice(0, 300),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    };
  };
  const label = (el) => {
    const n = el.tagName.toLowerCase() + (el.id ? '#' + el.id : el.classList[0] ? '.' + el.classList[0] : '');
    const r = el.getBoundingClientRect();
    return n + ' · ' + Math.round(r.width) + ' × ' + Math.round(r.height);
  };
  const show = (el) => {
    if (!el) { hover.style.display = 'none'; tag.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(hover.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    tag.textContent = label(el);
    Object.assign(tag.style, { display: 'block', left: r.left + 'px', top: Math.max(0, r.top - 20) + 'px' });
  };
  const done = (value) => {
    layer.remove(); hover.remove(); tag.remove(); box.remove();
    window.removeEventListener('keydown', onKey, true);
    window.__styxPickCancel = undefined;
    resolve(value);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
  window.addEventListener('keydown', onKey, true);
  window.__styxPickCancel = () => done(null);
  layer.addEventListener('mousemove', (e) => {
    if (start) {
      const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
      Object.assign(box.style, { display: 'block', left: x + 'px', top: y + 'px', width: Math.abs(e.clientX - start.x) + 'px', height: Math.abs(e.clientY - start.y) + 'px' });
      hover.style.display = 'none';
      tag.textContent = 'Area · ' + Math.abs(e.clientX - start.x) + ' × ' + Math.abs(e.clientY - start.y);
      Object.assign(tag.style, { display: 'block', left: x + 'px', top: Math.max(0, y - 20) + 'px' });
    } else show(under(e.clientX, e.clientY));
  });
  layer.addEventListener('mousedown', (e) => { e.preventDefault(); start = { x: e.clientX, y: e.clientY }; });
  layer.addEventListener('mouseup', (e) => {
    if (!start) return;
    const s = start; start = null;
    const path = location.pathname + location.search;
    if (Math.abs(e.clientX - s.x) < 5 && Math.abs(e.clientY - s.y) < 5) {
      const el = under(e.clientX, e.clientY);
      if (!el) return;
      const d = describe(el);
      done({ kind: 'element', path, rect: d.rect, items: [d] });
      return;
    }
    const x0 = Math.min(s.x, e.clientX), y0 = Math.min(s.y, e.clientY), x1 = Math.max(s.x, e.clientX), y1 = Math.max(s.y, e.clientY);
    const inside = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('[data-styx-pick]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.left >= x0 - 2 && r.top >= y0 - 2 && r.right <= x1 + 2 && r.bottom <= y1 + 2) inside.push(el);
    }
    // Outermost first: an element whose parent is also inside is part of something already listed.
    const top = inside.filter((el) => !inside.includes(el.parentElement));
    done({ kind: 'area', path, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, items: top.slice(0, 16).map(describe) });
  });
})`;
