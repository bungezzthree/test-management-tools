import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { STATUS_COLORS } from './i18n.js';

// A Unicode TTF renders names and notes that the built-in Helvetica (WinAnsi) cannot.
const FONT_CANDIDATES = {
  regular: [process.env.PDF_FONT_REGULAR, 'C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'],
  bold: [process.env.PDF_FONT_BOLD, 'C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'],
};
const findFont = (list) => list.find((p) => p && fs.existsSync(p));

const PRIMARY = '#1f4e79';
const TEXT = '#202124';
const MUTED = '#5f6368';
const BORDER = '#dadce0';
const SHADE = '#f8f9fa';

export function renderPdf(report, out) {
  const doc = new PDFDocument({
    size: 'A4', bufferPages: true,
    margins: { top: 48, bottom: 56, left: 44, right: 44 },
    info: { Title: report.title, Creator: 'Test Management Tools' },
  });
  doc.pipe(out);

  const regular = findFont(FONT_CANDIDATES.regular);
  const bold = findFont(FONT_CANDIDATES.bold);
  const F = { reg: 'Helvetica', bold: 'Helvetica-Bold' };
  if (regular && bold) {
    doc.registerFont('R', regular);
    doc.registerFont('B', bold);
    F.reg = 'R';
    F.bold = 'B';
  }

  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
  const textOf = (c) => (c && typeof c === 'object' ? c.text : String(c ?? ''));

  function table(columns, rows, { header = true, fontSize = 9, x = L, width = W, kv = false } = {}) {
    const widths = columns.map((c) => c.width * width);
    const pad = 4;
    const maxRow = bottom() - doc.page.margins.top - 20;
    const measure = (cells, isHeader) => Math.min(maxRow, Math.max(...cells.map((c, i) => {
      doc.font(isHeader || (kv && i === 0) ? F.bold : F.reg).fontSize(fontSize);
      return doc.heightOfString(textOf(c) || ' ', { width: widths[i] - pad * 2 });
    })) + pad * 2);

    const drawRow = (cells, isHeader, zebra) => {
      const h = measure(cells, isHeader);
      if (doc.y + h > bottom()) {
        doc.addPage();
        if (!isHeader && header) drawRow(columns.map((c) => c.label), true);
      }
      const y = doc.y;
      let cx = x;
      cells.forEach((c, i) => {
        const w = widths[i];
        if (isHeader) doc.rect(cx, y, w, h).fill(PRIMARY);
        else if ((kv && i === 0) || zebra) doc.rect(cx, y, w, h).fill(SHADE);
        doc.rect(cx, y, w, h).lineWidth(0.5).strokeColor(BORDER).stroke();
        const status = c && typeof c === 'object';
        doc.font(isHeader || (kv && i === 0) || status ? F.bold : F.reg).fontSize(fontSize)
          .fillColor(isHeader ? '#ffffff' : status ? STATUS_COLORS[c.status] || TEXT : TEXT)
          .text(textOf(c), cx + pad, y + pad, { width: w - pad * 2, height: h - pad * 2, align: columns[i].align || 'left', ellipsis: true });
        cx += w;
      });
      doc.x = L;
      doc.y = y + h;
    };

    // keep the header together with at least the first row
    const firstH = (header ? measure(columns.map((c) => c.label), true) : 0) + (rows.length ? measure(rows[0], false) : 0);
    if (doc.y + firstH > bottom()) doc.addPage();
    if (header) drawRow(columns.map((c) => c.label), true);
    rows.forEach((r, i) => drawRow(r, false, !kv && i % 2 === 1));
    doc.y += 8;
  }

  const blocks = {
    title(b) {
      doc.font(F.bold).fontSize(17).fillColor(PRIMARY).text(b.text, L, doc.y, { width: W, align: b.center ? 'center' : 'left' });
      doc.font(F.reg).fontSize(11).fillColor(MUTED).text(b.subtitle, { width: W, align: b.center ? 'center' : 'left' });
      if (b.meta) doc.fontSize(10).fillColor(TEXT).text(b.meta, { width: W, align: b.center ? 'center' : 'left' });
      doc.moveDown(0.4);
      doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(2).strokeColor(PRIMARY).stroke();
      doc.moveDown(0.8);
    },
    h2(b) {
      ensure(60);
      doc.moveDown(0.6);
      doc.font(F.bold).fontSize(12).fillColor(PRIMARY).text(b.text, L, doc.y, { width: W });
      doc.moveTo(L, doc.y + 2).lineTo(L + W, doc.y + 2).lineWidth(0.5).strokeColor(BORDER).stroke();
      doc.y += 8;
    },
    h3(b) {
      ensure(70);
      doc.moveDown(0.4);
      const y = doc.y;
      doc.font(F.bold).fontSize(10);
      const statusW = b.statusText ? doc.widthOfString(b.statusText) + 16 : 0;
      const h = doc.heightOfString(b.text, { width: W - statusW - 16 }) + 10;
      doc.rect(L, y, W, h).fill('#e8f0fe');
      doc.fillColor(TEXT).text(b.text, L + 6, y + 5, { width: W - statusW - 16 });
      if (b.statusText) {
        doc.roundedRect(L + W - statusW - 4, y + 4, statusW, 14, 7).fill(STATUS_COLORS[b.status] || MUTED);
        doc.font(F.bold).fontSize(8).fillColor('#ffffff').text(b.statusText, L + W - statusW - 4, y + 7.5, { width: statusW, align: 'center' });
      }
      doc.x = L;
      doc.y = y + h + 4;
    },
    p(b) {
      const indent = b.indent ? 22 : 0;
      doc.font(b.bold ? F.bold : F.reg).fontSize(10).fillColor(TEXT);
      ensure(doc.heightOfString(b.text, { width: W - indent }) + 6);
      doc.text(b.text, L + indent, doc.y, { width: W - indent, align: 'justify' });
      doc.x = L;
      doc.moveDown(0.5);
    },
    kv(b) {
      const offset = b.numbered ? 16 : 0;
      if (b.numbered) {
        ensure(40);
        doc.font(F.bold).fontSize(10).fillColor(TEXT).text(`${b.numbered}.`, L, doc.y + 4, { lineBreak: false });
        doc.y -= 4;
      }
      table([{ width: 0.28 }, { width: 0.72 }], b.rows, { header: false, kv: true, x: L + offset, width: W - offset, fontSize: b.compact ? 8.5 : 9 });
    },
    table(b) {
      table(b.columns, b.rows, { fontSize: b.small ? 8 : 8.5 });
    },
    stats(b) {
      ensure(56);
      const gap = 6;
      const bw = (W - gap * (b.items.length - 1)) / b.items.length;
      const y = doc.y;
      b.items.forEach((it, i) => {
        const x = L + i * (bw + gap);
        doc.rect(x, y, bw, 46).lineWidth(0.5).strokeColor(BORDER).stroke();
        doc.rect(x, y, bw, 4).fill(STATUS_COLORS[it.status] || PRIMARY);
        doc.font(F.bold).fontSize(16).fillColor(TEXT).text(String(it.value), x, y + 10, { width: bw, align: 'center' });
        doc.font(F.reg).fontSize(8).fillColor(MUTED).text(it.label, x, y + 31, { width: bw, align: 'center' });
      });
      doc.x = L;
      doc.y = y + 54;
    },
    bar(b) {
      ensure(20);
      const y = doc.y;
      doc.rect(L, y, W, 10).fill('#e8eaed');
      let x = L;
      if (b.total) {
        for (const s of b.segments) {
          if (!s.value) continue;
          const w = (s.value / b.total) * W;
          doc.rect(x, y, w, 10).fill(STATUS_COLORS[s.status]);
          x += w;
        }
      }
      doc.y = y + 18;
    },
    callout(b) {
      doc.font(F.reg).fontSize(10);
      const text = `${b.title}: ${b.text}`;
      const h = doc.heightOfString(text, { width: W - 24 }) + 16;
      ensure(h + 6);
      const y = doc.y;
      doc.rect(L, y, W, h).fill(SHADE);
      doc.rect(L, y, 4, h).fill(STATUS_COLORS[b.status] || PRIMARY);
      doc.font(F.bold).fillColor(TEXT).text(`${b.title}: `, L + 14, y + 8, { continued: true, width: W - 24 })
        .font(F.reg).text(b.text);
      doc.x = L;
      doc.y = y + h + 8;
    },
    evidence(b) {
      doc.font(F.bold).fontSize(9).fillColor(TEXT);
      if (!b.items.length) {
        doc.font(F.reg).fontSize(8.5).fillColor(MUTED).text(`${b.label}: ${b.empty}`, L, doc.y, { width: W });
        doc.moveDown(0.5);
        return;
      }
      const images = b.items.filter((i) => i.exists && /^image\/(png|jpe?g)$/.test(i.mime || ''));
      const others = b.items.filter((i) => !images.includes(i));
      ensure(30);
      doc.text(b.label, L, doc.y);
      doc.moveDown(0.3);
      const gap = 10;
      const bw = (W - gap) / 2;
      const bh = 200;
      for (let i = 0; i < images.length; i += 2) {
        ensure(bh + 22);
        const y = doc.y;
        images.slice(i, i + 2).forEach((img, j) => {
          const x = L + j * (bw + gap);
          doc.rect(x, y, bw, bh + 16).lineWidth(0.5).strokeColor(BORDER).stroke();
          try {
            doc.image(img.file, x + 4, y + 4, { fit: [bw - 8, bh - 4], align: 'center', valign: 'center' });
          } catch {
            doc.font(F.reg).fontSize(8).fillColor(MUTED).text('(image could not be rendered)', x + 4, y + bh / 2, { width: bw - 8, align: 'center' });
          }
          doc.font(F.reg).fontSize(7).fillColor(MUTED).text(img.name, x + 4, y + bh + 3, { width: bw - 8, height: 10, ellipsis: true, lineBreak: false });
        });
        doc.x = L;
        doc.y = y + bh + 24;
      }
      if (others.length) {
        doc.font(F.reg).fontSize(8).fillColor(MUTED).text(`${b.otherLabel}: ${others.map((o) => o.name).join(', ')}`, L, doc.y, { width: W });
        doc.moveDown(0.5);
      }
    },
    signatures(b) {
      ensure(150);
      doc.moveDown(1);
      const y = doc.y;
      const gap = 40;
      const cw = (W - gap) / 2;
      let maxY = y;
      b.parties.forEach((p, i) => {
        const x = L + i * (cw + gap);
        doc.font(F.bold).fontSize(10).fillColor(TEXT).text(p.label, x, y, { width: cw, align: 'center' });
        doc.font(F.bold).fontSize(9).fillColor(STATUS_COLORS[p.decisionStatus] || MUTED).text(p.decision, x, y + 16, { width: cw, align: 'center' });
        doc.font(F.reg).fontSize(7.5).fillColor(MUTED).text(p.date || ' ', x, y + 30, { width: cw, align: 'center' });
        doc.moveTo(x + 20, y + 90).lineTo(x + cw - 20, y + 90).lineWidth(0.8).strokeColor(TEXT).stroke();
        doc.font(F.bold).fontSize(10).fillColor(TEXT).text(p.name || ' ', x, y + 76, { width: cw, align: 'center' });
        doc.font(F.reg).fontSize(8.5).fillColor(TEXT).text([p.title, p.company].filter(Boolean).join(' — ') || ' ', x, y + 95, { width: cw, align: 'center' });
        if (p.note) doc.font(F.reg).fontSize(8).fillColor(MUTED).text(p.note, x, doc.y + 2, { width: cw, align: 'center' });
        maxY = Math.max(maxY, doc.y);
      });
      doc.x = L;
      doc.y = maxY + 12;
    },
    pagebreak() {
      doc.addPage();
    },
  };

  for (const b of report.blocks) blocks[b.type](b);

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // writing in the footer area must not trigger a new page
    const y = doc.page.height - 34;
    doc.moveTo(L, y - 6).lineTo(L + W, y - 6).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.font(F.reg).fontSize(7.5).fillColor(MUTED)
      .text(report.title, L, y, { width: W * 0.7, lineBreak: false, ellipsis: true })
      .text(report.t.page(i + 1, range.count), L + W * 0.7, y, { width: W * 0.3, align: 'right', lineBreak: false });
  }
  doc.end();
}
