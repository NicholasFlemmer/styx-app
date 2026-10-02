import { fill, copy, screenName, type DesignFile } from '@styx/core';

/**
 * The canvas's handling of a design screen (#140): each one is drawn in a sandboxed frame with no scripts (the
 * renderer reads and edits its document directly), its tokens inlined in place of the `tokens.css` link, and a little
 * style for the selection outlines. Saving takes those back out so the file is what the agent wrote, plus the edit.
 */
export const TOKENS_STYLE = 'data-styx-tokens';
export const UI_STYLE = 'data-styx-ui';
export const HOVER_ATTR = 'data-styx-hover';
export const PICKED_ATTR = 'data-styx-picked';

const UI_CSS = `[${HOVER_ATTR}]{outline:1.5px dashed #9fc21c !important;outline-offset:2px !important}
[${PICKED_ATTR}]{outline:2px solid #d6ff3d !important;outline-offset:3px !important}
html,body{cursor:default}`;

/**
 * The frame's own policy, ahead of anything the agent wrote: nothing loads from anywhere (no frames, no files, no
 * network), only inline styles and data: images and fonts.
 */
export const FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; form-action 'none'";

/** The frame's document: scripts out, the tokens link replaced by the tokens themselves, the selection style in. */
export const buildSrcdoc = (html: string, css: string): string => {
  const clean = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<link\b[^>]*tokens\.css[^>]*>/gi, '')
    // Hints a policy does not cover (DNS prefetch, preconnect) could still reach the network: out.
    .replace(/<link\b[^>]*rel\s*=\s*["']?[^"'>]*(prefetch|preconnect|preload|prerender)[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '');
  const policy = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(clean)?.[0] ?? '';
  return withPolicy(doctype, policy, clean.slice(doctype.length), css);
};

const withPolicy = (doctype: string, policy: string, rest: string, css: string): string => {
  const clean = rest;
  const head = `<style ${TOKENS_STYLE}>${css}</style><style ${UI_STYLE}>${UI_CSS}</style>`;
  // The policy goes first of all (the parser puts a leading <meta> in the head before any of the agent's markup).
  if (/<head[^>]*>/i.test(clean))
    return `${doctype}${policy}${clean.replace(/<head([^>]*)>/i, `<head$1>${head}`)}`;
  if (/<html[^>]*>/i.test(clean))
    return `${doctype}${policy}${clean.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`)}`;
  return `<!doctype html>${policy}<html><head>${head}</head><body>${clean}</body></html>`;
};

/** The file to save from an edited frame: the tokens link back, Styx's styles and outline marks gone. */
export const serializeForSave = (doc: Document): string => {
  const copyDoc = doc.documentElement.cloneNode(true) as HTMLElement;
  for (const el of copyDoc.querySelectorAll(`[${UI_STYLE}], meta[http-equiv="Content-Security-Policy"]`))
    el.remove();
  const tokens = copyDoc.querySelector(`[${TOKENS_STYLE}]`);
  if (tokens !== null) {
    const link = doc.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href', '../tokens.css');
    tokens.replaceWith(link);
  }
  for (const el of copyDoc.querySelectorAll(`[${HOVER_ATTR}],[${PICKED_ATTR}]`)) {
    el.removeAttribute(HOVER_ATTR);
    el.removeAttribute(PICKED_ATTR);
  }
  return `<!doctype html>\n${copyDoc.outerHTML}\n`;
};

/** A readable name for an element: its id or first class in words, else its tag and a bit of its text. */
export const elementName = (el: Element): string => {
  const words = (s: string) => {
    const w = s
      .replace(/[-_]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .trim()
      .toLowerCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  };
  const tag = el.tagName.toLowerCase();
  const kind = tag === 'button' || el.getAttribute('role') === 'button' ? 'button' : tag;
  if (el.id !== '') return words(el.id);
  const cls = el.classList[0];
  if (cls !== undefined) return words(cls);
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  return text === '' ? kind : `${kind} “${text.slice(0, 30)}${text.length > 30 ? '…' : ''}”`;
};

/** A CSS path the agent can find again: ids where there are any, else tags with :nth-of-type. */
export const selectorOf = (el: Element): string => {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur !== null && cur.tagName.toLowerCase() !== 'html') {
    const tag = cur.tagName.toLowerCase();
    if (cur.id !== '') {
      parts.unshift(`#${cur.id}`);
      break;
    }
    const parent: Element | null = cur.parentElement;
    const same = parent === null ? [] : [...parent.children].filter((c) => c.tagName === cur?.tagName);
    const cls = cur.classList[0];
    parts.unshift(
      `${tag}${cls !== undefined ? `.${cls}` : ''}${same.length > 1 ? `:nth-of-type(${same.indexOf(cur) + 1})` : ''}`,
    );
    cur = parent;
  }
  return parts.join(' > ');
};

/** Elements wholly inside a rectangle (frame coordinates), outermost only. */
export const elementsInRect = (
  doc: Document,
  r: { x: number; y: number; width: number; height: number },
): Element[] => {
  const x1 = r.x + r.width;
  const y1 = r.y + r.height;
  const inside: Element[] = [];
  for (const el of doc.body?.querySelectorAll('*') ?? []) {
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    if (b.left >= r.x - 2 && b.top >= r.y - 2 && b.right <= x1 + 2 && b.bottom <= y1 + 2) inside.push(el);
  }
  return inside.filter((el) => el.parentElement === null || !inside.includes(el.parentElement));
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** An element's markup as the file has it: without the canvas's own outline marks. */
const markup = (el: Element): string => {
  const c = el.cloneNode(true) as Element;
  for (const x of [c, ...c.querySelectorAll(`[${HOVER_ATTR}],[${PICKED_ATTR}]`)]) {
    x.removeAttribute(HOVER_ATTR);
    x.removeAttribute(PICKED_ATTR);
  }
  return c.outerHTML.replace(/\s+/g, ' ');
};

export type CanvasSelection =
  | { kind: 'element'; file: DesignFile; el: Element; rect: DOMRect }
  | {
      kind: 'area';
      file: DesignFile;
      els: Element[];
      rect: { x: number; y: number; width: number; height: number };
    };

/** The chip label and the agent's detail for a selection on the canvas. */
export const describeSelection = (sel: CanvasSelection): { label: string; detail: string } => {
  const screen = screenName(sel.file.screen);
  const where = `${sel.file.path} (${copy.chat.design.size[sel.file.size]}, ${
    sel.file.fidelity === 'wire' ? copy.chat.design.wireframe : copy.chat.design.hifi
  })`;
  if (sel.kind === 'element') {
    return {
      label: clip(`${screen} › ${elementName(sel.el)}`, 190),
      detail: [
        `Screen: .styx/designs/${where}`,
        `Element: ${selectorOf(sel.el)}`,
        `Markup: ${clip(markup(sel.el), 1500)}`,
        'A picture of it is attached.',
      ].join('\n'),
    };
  }
  const w = Math.round(sel.rect.width);
  const h = Math.round(sel.rect.height);
  return {
    label: clip(`${screen} › Area: ${sel.els.map(elementName).join(', ') || `${w} × ${h}`}`, 190),
    detail: [
      `Screen: .styx/designs/${where}`,
      `An area ${w} × ${h} px at (${Math.round(sel.rect.x)}, ${Math.round(sel.rect.y)}) holding ${sel.els.length} element(s):`,
      ...sel.els.map((el, i) => `${i + 1}. ${selectorOf(el)}: ${clip(markup(el), 600)}`),
      'A picture of it is attached.',
    ].join('\n'),
  };
};

/** "Area · 3 elements · 236 × 104". */
export const areaTag = (n: number, w: number, h: number): string =>
  fill(n === 1 ? copy.chat.design.area.tagOne : copy.chat.design.area.tag, {
    n,
    w: Math.round(w),
    h: Math.round(h),
  });
