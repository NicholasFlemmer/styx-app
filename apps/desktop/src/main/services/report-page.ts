import type { ReportResult } from '@styx/core';

/**
 * A report as a page of its own (mockup design/next/styx-one-results.html, frame 6): what a client opens from a
 * shared link, and what Download PDF prints. Everything in a report came from an agent, so every string is escaped;
 * the page has no scripts and loads nothing from elsewhere.
 */

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** A this-period line and, dashed, the last period's, scaled together. */
const trendSvg = (t: NonNullable<ReportResult['trend']>): string => {
  const all = [...t.current, ...(t.previous ?? [])];
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const pts = (xs: number[]) =>
    xs
      .map((v, i) => {
        const x = xs.length === 1 ? 0 : (i / (xs.length - 1)) * 600;
        const y = 150 - ((v - min) / (max - min || 1)) * 140 - 5;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  const labels = t.labels
    .map((l, i) => {
      const x = t.labels.length === 1 ? 0 : (i / (t.labels.length - 1)) * 600;
      const anchor = i === 0 ? 'start' : i === t.labels.length - 1 ? 'end' : 'middle';
      return `<text x="${x.toFixed(1)}" y="172" text-anchor="${anchor}">${esc(l)}</text>`;
    })
    .join('');
  return `<figure class="trend"><figcaption>${esc(t.title)}<span> — this period${
    t.previous !== undefined && t.previous.length > 1 ? ' · · · the one before' : ''
  }</span></figcaption><svg viewBox="0 -2 600 180" role="img" aria-label="${esc(t.title)}">${
    t.previous !== undefined && t.previous.length > 1
      ? `<polyline class="prev" points="${pts(t.previous)}"/>`
      : ''
  }<polyline class="cur" points="${pts(t.current)}"/>${labels}</svg></figure>`;
};

export const REPORT_CSS = `
:root{color-scheme:light}*{box-sizing:border-box}
body{margin:0;background:#f7f8f3;color:#14160f;font:15px/1.55 Archivo,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:820px;margin:0 auto;padding:40px 24px 56px}
.meta{color:#5d6259;font-size:13px;margin:0 0 10px}
h1{font-size:30px;line-height:1.15;font-weight:600;letter-spacing:-.01em;margin:0 0 12px;max-width:28ch}
.lede{margin:0 0 22px;max-width:68ch}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin:0 0 26px;padding:0}
.kpi{border:1px solid #d6d9cf;background:#fff;padding:12px 14px;list-style:none}
.kpi span{display:block;font-size:12px;color:#5d6259}.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.kpi em{font-style:normal;font-size:12px;color:#5d6259}.kpi em.good{color:#3f5600}.kpi em.bad{color:#14160f;font-weight:600}
h2{font-size:17px;font-weight:600;margin:26px 0 10px}
.trend{margin:0 0 20px}.trend figcaption{font-weight:600;margin-bottom:6px}.trend figcaption span{font-weight:400;color:#5d6259;font-size:13px}
.trend svg{width:100%;height:auto;overflow:visible}.trend .cur{fill:none;stroke:#14160f;stroke-width:2.5}
.trend .prev{fill:none;stroke:#b3b7ab;stroke-width:2;stroke-dasharray:5 5}.trend text{font-size:12px;fill:#5d6259}
.bars{list-style:none;margin:0 0 20px;padding:0}.bars li{display:grid;grid-template-columns:minmax(120px,190px) 1fr 90px;gap:10px;align-items:center;font-size:13px;margin:5px 0}
.bars i{display:block;height:10px;background:#e1e3db}.bars i b{display:block;height:100%;background:#14160f}.bars span.n{text-align:right;color:#5d6259;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums;margin:0 0 20px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #d6d9cf}thead th{color:#5d6259;font-weight:600}tbody th{font-weight:500}
.recs{list-style:none;margin:0;padding:0}.recs li{border-top:1px solid #d6d9cf;padding:10px 0}.recs b{font-weight:600}.recs span{color:#5d6259}
footer{margin-top:40px;color:#5d6259;font-size:12px}
@media print{body{background:#fff}main{padding:0}}
`;

export interface ReportPageInput {
  report: ReportResult;
  project: string;
  sharedBy: string;
  /** When this copy was made, in words: "Mon 17 Nov, 07:00". */
  updated: string;
  /** `link`: the stylesheet beside it (a shared site); `inline`: one self-contained file (the PDF). */
  css: 'link' | 'inline';
}

/** The report as a page; read-only, no scripts. */
export const reportPage = ({ report: r, project, sharedBy, updated, css }: ReportPageInput): string => {
  const max = Math.max(1, ...(r.bars?.items.map((b) => b.value) ?? [1]));
  const meta = [
    sharedBy !== '' ? `Shared by ${esc(sharedBy)}` : '',
    project !== '' ? esc(project) : '',
    r.period !== undefined ? esc(r.period) : '',
    `updated ${esc(r.asOf ?? updated)}`,
    r.sources.length > 0 ? `from ${esc(r.sources.join(' and '))}` : '',
  ]
    .filter((x) => x !== '')
    .join(' · ');
  const kpis =
    r.metrics.length === 0
      ? ''
      : `<ul class="kpis">${r.metrics
          .map(
            (m) =>
              `<li class="kpi"><span>${esc(m.label)}</span><b>${esc(m.value)}</b>${
                m.change === undefined
                  ? ''
                  : `<em class="${m.good === true ? 'good' : m.good === false ? 'bad' : ''}">${esc(m.change)}</em>`
              }</li>`,
          )
          .join('')}</ul>`;
  const bars =
    r.bars === undefined
      ? ''
      : `<h2>${esc(r.bars.title)}</h2><ul class="bars">${r.bars.items
          .map(
            (b) =>
              `<li><span>${esc(b.label)}</span><i><b style="width:${((b.value / max) * 100).toFixed(1)}%"></b></i><span class="n">${b.value.toLocaleString('en-ZA')}</span></li>`,
          )
          .join('')}</ul>`;
  const table =
    r.table === undefined
      ? ''
      : `<table><thead><tr>${r.table.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${r.table.rows
          .map(
            (row) =>
              `<tr>${row.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`,
          )
          .join('')}</tbody></table>`;
  const recs =
    r.recommendations.length === 0
      ? ''
      : `<h2>What to do</h2><ul class="recs">${r.recommendations
          .map(
            (x) =>
              `<li><b>${esc(x.title)}</b>${x.why === undefined ? '' : ` <span>${esc(x.why)}</span>`}</li>`,
          )
          .join('')}</ul>`;
  const style =
    css === 'inline' ? `<style>${REPORT_CSS}</style>` : '<link rel="stylesheet" href="style.css">';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(r.title)}</title>${style}</head><body><main><p class="meta">${meta}</p><h1>${esc(r.headline)}</h1>${
    r.summary === undefined ? '' : `<p class="lede">${esc(r.summary)}</p>`
  }${kpis}${r.trend === undefined ? '' : trendSvg(r.trend)}${bars}${table}${recs}<footer>Read only. Made with Styx.</footer></main></body></html>`;
};
