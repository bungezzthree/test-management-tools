import { buildReport } from './builder.js';
import { renderHtml } from './html.js';
import { renderPdf } from './pdf.js';
import { HttpError } from '../db.js';

const safeName = (s) => s.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(0, 120);

/**
 * GET /api/plans/:id/report?type=sit|uat|bast&lang=id|en&format=html|pdf
 *   &details=0 (summary only) &evidence=0 (no screenshots) &download=1 &doc_no=...
 */
export async function renderReport(req, res, planId) {
  const type = String(req.query.type || 'sit').toLowerCase();
  if (!['sit', 'uat', 'bast'].includes(type)) throw new HttpError(400, 'type must be sit, uat or bast');
  const lang = req.query.lang === 'en' ? 'en' : 'id';
  const format = req.query.format === 'pdf' ? 'pdf' : 'html';
  const report = buildReport({
    planId, type, lang, user: req.user,
    details: req.query.details !== '0',
    evidence: req.query.evidence !== '0',
    docNo: String(req.query.doc_no || '').slice(0, 100),
  });
  const filename = `${safeName(report.title)}_${lang.toUpperCase()}.${format}`;
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);

  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    renderPdf(report, res);
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderHtml(report, { toolbar: !req.query.download }));
  }
}
