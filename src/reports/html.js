import fs from 'node:fs';
import { STATUS_COLORS } from './i18n.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl = (v) => esc(v).replace(/\n/g, '<br>');
const MAX_EMBED = 8 * 1024 * 1024;

function cell(c, align) {
  const a = align ? ` style="text-align:${align}"` : '';
  if (c && typeof c === 'object') return `<td${a}><span class="badge" style="background:${STATUS_COLORS[c.status] || '#5f6368'}">${esc(c.text)}</span></td>`;
  return `<td${a}>${nl(c)}</td>`;
}

const renderers = {
  title: (b) => `<header class="doc-title${b.center ? ' center' : ''}"><h1>${esc(b.text)}</h1><div class="subtitle">${esc(b.subtitle)}</div>${b.meta ? `<div class="meta">${esc(b.meta)}</div>` : ''}</header>`,
  h2: (b) => `<h2>${esc(b.text)}</h2>`,
  h3: (b) => `<h3>${esc(b.text)} ${b.status ? `<span class="badge" style="background:${STATUS_COLORS[b.status]}">${esc(b.statusText)}</span>` : ''}</h3>`,
  p: (b) => `<p class="${b.bold ? 'bold' : ''} ${b.indent ? 'indent' : ''}">${nl(b.text)}</p>`,
  pagebreak: () => '<div class="pagebreak"></div>',
  kv: (b) => `${b.numbered ? `<div class="numbered"><span class="num">${b.numbered}.</span>` : ''}<table class="kv${b.compact ? ' compact' : ''}">${b.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${nl(v)}</td></tr>`).join('')}</table>${b.numbered ? '</div>' : ''}`,
  table: (b) => `<table class="grid${b.small ? ' small' : ''}"><colgroup>${b.columns.map((c) => `<col style="width:${(c.width * 100).toFixed(1)}%">`).join('')}</colgroup>
    <thead><tr>${b.columns.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${b.rows.map((r) => `<tr>${r.map((c, i) => cell(c, b.columns[i].align)).join('')}</tr>`).join('')}</tbody></table>`,
  stats: (b) => `<div class="stats">${b.items.map((i) => `<div class="stat" style="border-top-color:${STATUS_COLORS[i.status] || '#1f4e79'}"><div class="v">${esc(i.value)}</div><div class="l">${esc(i.label)}</div></div>`).join('')}</div>`,
  bar: (b) => `<div class="bar">${b.total ? b.segments.filter((s) => s.value).map((s) => `<span title="${esc(s.status)}: ${s.value}" style="width:${(s.value / b.total) * 100}%;background:${STATUS_COLORS[s.status]}"></span>`).join('') : ''}</div>`,
  callout: (b) => `<div class="callout" style="border-left-color:${STATUS_COLORS[b.status]}"><strong>${esc(b.title)}:</strong> ${nl(b.text)}</div>`,
  evidence: (b) => {
    if (!b.items.length) return `<p class="muted small">${esc(b.label)}: ${esc(b.empty)}</p>`;
    const images = b.items.filter((i) => i.exists && /^image\/(png|jpe?g|gif|webp)$/.test(i.mime || '') && i.size <= MAX_EMBED);
    const others = b.items.filter((i) => !images.includes(i));
    let html = `<div class="evidence-label">${esc(b.label)}</div><div class="evidence">`;
    for (const i of images) {
      const data = fs.readFileSync(i.file).toString('base64');
      html += `<figure><img src="data:${esc(i.mime)};base64,${data}" alt="${esc(i.name)}"><figcaption>${esc(i.name)}</figcaption></figure>`;
    }
    html += '</div>';
    if (others.length) html += `<p class="small muted">${esc(b.otherLabel)}: ${others.map((o) => esc(o.name)).join(', ')}</p>`;
    return html;
  },
  signatures: (b) => `<div class="signatures">${b.parties.map((p) => `<div class="sig">
      <div class="sig-label">${esc(p.label)}</div>
      <div class="sig-decision" style="color:${STATUS_COLORS[p.decisionStatus] || '#5f6368'}">${esc(p.decision)}</div>
      <div class="sig-date">${esc(p.date)}</div>
      <div class="sig-line">${esc(p.name) || '&nbsp;'}</div>
      <div class="sig-meta">${esc([p.title, p.company].filter(Boolean).join(' — '))}</div>
      ${p.note ? `<div class="sig-note">${nl(p.note)}</div>` : ''}
    </div>`).join('')}</div>`,
};

const CSS = `
*{box-sizing:border-box}
body{font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#202124;margin:0;background:#f1f3f4;font-size:13px;line-height:1.45}
.page{max-width:900px;margin:24px auto;background:#fff;padding:40px 48px;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.toolbar{max-width:900px;margin:16px auto 0;display:flex;gap:8px;justify-content:flex-end}
.toolbar button{font:inherit;padding:6px 14px;border:1px solid #1f4e79;background:#1f4e79;color:#fff;border-radius:4px;cursor:pointer}
.doc-title{border-bottom:3px solid #1f4e79;padding-bottom:10px;margin-bottom:18px}
.doc-title.center{text-align:center}
h1{font-size:22px;margin:0;color:#1f4e79}
.subtitle{font-size:14px;color:#5f6368;margin-top:4px}
.meta{font-size:12px;margin-top:6px}
h2{font-size:15px;color:#1f4e79;border-bottom:1px solid #dadce0;padding-bottom:4px;margin:26px 0 10px}
h3{font-size:13px;margin:20px 0 6px;padding:6px 8px;background:#e8f0fe;border-radius:4px}
p.bold{font-weight:600} p.indent{margin-left:24px}
.muted{color:#5f6368}.small{font-size:11px}
table{border-collapse:collapse;width:100%;margin:6px 0 10px}
table.kv th{text-align:left;width:28%;font-weight:600;color:#3c4043;padding:4px 8px;vertical-align:top;background:#f8f9fa;border:1px solid #e8eaed}
table.kv td{padding:4px 8px;border:1px solid #e8eaed;vertical-align:top}
table.kv.compact th,table.kv.compact td{padding:3px 8px;font-size:12px}
.numbered{display:flex;gap:6px}.numbered .num{font-weight:600;padding-top:4px}
table.grid th{background:#1f4e79;color:#fff;font-weight:600;padding:5px 6px;text-align:left;font-size:12px}
table.grid td{border:1px solid #dadce0;padding:4px 6px;vertical-align:top}
table.grid tbody tr:nth-child(even) td{background:#f8f9fa}
table.grid.small td,table.grid.small th{font-size:11px}
.badge{display:inline-block;color:#fff;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:600;white-space:nowrap}
.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:8px 0}
.stat{border:1px solid #dadce0;border-top:4px solid;border-radius:4px;padding:8px;text-align:center}
.stat .v{font-size:22px;font-weight:700}.stat .l{font-size:11px;color:#5f6368}
.bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:#e8eaed;margin:8px 0}
.callout{border-left:5px solid;background:#f8f9fa;padding:10px 12px;margin:10px 0}
.evidence-label{font-weight:600;font-size:12px;margin-top:6px}
.evidence{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:6px 0 12px}
.evidence figure{margin:0;border:1px solid #dadce0;padding:4px;border-radius:4px;break-inside:avoid}
.evidence img{width:100%;max-height:360px;object-fit:contain;display:block}
.evidence figcaption{font-size:10px;color:#5f6368;margin-top:2px;word-break:break-all}
.signatures{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:20px;break-inside:avoid}
.sig{text-align:center}
.sig-label{font-weight:700}
.sig-decision{font-weight:600;margin-top:6px}
.sig-date{font-size:11px;color:#5f6368;min-height:16px}
.sig-line{margin-top:48px;border-bottom:1px solid #202124;font-weight:600;padding-bottom:2px}
.sig-meta{font-size:12px;color:#3c4043;margin-top:2px}
.sig-note{font-size:11px;font-style:italic;margin-top:4px}
.pagebreak{break-after:page;height:0}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:0}.toolbar{display:none}
  @page{size:A4;margin:16mm 14mm}h2,h3{break-after:avoid}tr{break-inside:avoid}}
@media (max-width:700px){.page{padding:20px 16px;margin:0}.stats{grid-template-columns:repeat(3,1fr)}.signatures{grid-template-columns:1fr}}
`;

export function renderHtml(report, { toolbar = true } = {}) {
  const body = report.blocks.map((b) => renderers[b.type](b)).join('\n');
  return `<!doctype html>
<html lang="${report.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(report.title)}</title><style>${CSS}</style></head>
<body>${toolbar ? `<div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>` : ''}
<main class="page">${body}</main></body></html>`;
}
