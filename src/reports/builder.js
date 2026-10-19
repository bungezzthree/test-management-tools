import path from 'node:path';
import fs from 'node:fs';
import { all, get, UPLOAD_DIR } from '../db.js';
import { getPlan, getProject, getCase, planCases, summarize, executionDetails } from '../services.js';
import { STRINGS } from './i18n.js';

const TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Jakarta';

/** SQLite CURRENT_TIMESTAMP values are UTC without a zone marker. */
const parseDb = (s) => (s ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z') : null);

export function formatters(t) {
  const dateTime = new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: TIMEZONE });
  const dateLong = new Intl.DateTimeFormat(t.locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: TIMEZONE });
  const weekday = new Intl.DateTimeFormat(t.locale, { weekday: 'long', timeZone: TIMEZONE });
  return {
    dt: (s) => (s ? dateTime.format(parseDb(s)) : '-'),
    // plan dates are plain YYYY-MM-DD
    d: (s) => (s ? dateLong.format(new Date(`${s}T12:00:00Z`)) : '-'),
    dLong: (date) => dateLong.format(date),
    weekday: (date) => weekday.format(date),
    parse: parseDb,
  };
}

const st = (t, status) => ({ text: t[status] || status, status });

function latestSignoffs(planId) {
  const rows = all('SELECT * FROM signoffs WHERE plan_id = ? ORDER BY id', planId);
  const latest = {};
  for (const r of rows) latest[r.party] = r;
  return latest;
}

function signatureBlock(t, f, signoffs, project) {
  const party = (key, label, fallbackCompany) => {
    const s = signoffs[key];
    return {
      label,
      name: s?.signer_name || '',
      title: s?.signer_title || '',
      company: s?.company || fallbackCompany || '',
      decision: s ? t[s.decision] || s.decision : t.notSigned,
      decisionStatus: s?.decision,
      note: s?.note || '',
      date: s ? `${t.signedElectronically}: ${f.dt(s.signed_at)}` : '',
    };
  };
  return { type: 'signatures', parties: [party('vendor', t.vendorParty, project.vendor_name), party('client', t.clientParty, project.client_name)] };
}

function summaryBlocks(t, s, withApproval) {
  const items = [
    { label: t.total, value: s.total },
    { label: t.Passed, value: s.Passed, status: 'Passed' },
    { label: t.Failed, value: s.Failed, status: 'Failed' },
    { label: t.Blocked, value: s.Blocked, status: 'Blocked' },
    { label: t.Skipped, value: s.Skipped, status: 'Skipped' },
    { label: t['Not Run'], value: s['Not Run'], status: 'Not Run' },
  ];
  const blocks = [
    { type: 'stats', items },
    { type: 'bar', total: s.total, segments: ['Passed', 'Failed', 'Blocked', 'Skipped', 'Not Run'].map((k) => ({ status: k, value: s[k] })) },
    { type: 'kv', rows: [
      [t.executed, `${s.executed} / ${s.total}`],
      [t.progress, `${s.progress}%`],
      [t.passRate, `${s.pass_rate}%`],
      ...(withApproval ? [[t.approval, `${t.Approved}: ${s.Approved} · ${t.Rejected}: ${s.Rejected} · ${t.pendingApproval}: ${s.PendingApproval}`]] : []),
    ] },
  ];
  return blocks;
}

function evidenceItems(attachments) {
  return attachments.map((a) => {
    const file = path.join(UPLOAD_DIR, path.basename(get('SELECT stored_name FROM attachments WHERE id = ?', a.id).stored_name));
    return { id: a.id, name: a.original_name, mime: a.mime_type, size: a.size, file, exists: fs.existsSync(file) };
  });
}

/** Builds a renderer-neutral list of blocks for the SIT or UAT report. */
function testReport(kind, planId, t, f, opts) {
  const plan = getPlan(planId);
  const project = getProject(plan.project_id);
  const rows = planCases(planId);
  const s = summarize(rows);
  const isUat = kind === 'uat';
  const blocks = [];

  blocks.push({ type: 'title', text: isUat ? t.uatTitle : t.sitTitle, subtitle: `${project.name} — ${plan.name}` });

  blocks.push({ type: 'h2', text: t.docInfo });
  blocks.push({ type: 'kv', rows: [
    ...(opts.docNo ? [[t.docNo, opts.docNo]] : []),
    [t.project, `${project.name} (${project.prefix})`],
    [t.client, project.client_name || '-'],
    [t.vendor, project.vendor_name || '-'],
    [t.plan, plan.name],
    [t.environment, plan.environment],
    [t.build, plan.build_version || '-'],
    [t.period, `${f.d(plan.start_date)} – ${f.d(plan.end_date)}`],
    ...(plan.description ? [[t.description, plan.description]] : []),
    [t.generatedAt, f.dt(new Date().toISOString())],
    [t.generatedBy, opts.user?.full_name || '-'],
  ] });

  blocks.push({ type: 'h2', text: t.summary });
  blocks.push(...summaryBlocks(t, s, isUat));
  const clean = s.Failed === 0 && s.Blocked === 0 && s['Not Run'] === 0;
  const verdict = isUat
    ? (clean && s.Rejected === 0 ? t.uatAccepted : t.uatNotAccepted(s))
    : (clean ? t.sitReady : t.sitNotReady(s));
  blocks.push({ type: 'callout', title: t.conclusion, text: verdict, status: (isUat ? clean && s.Rejected === 0 : clean) ? 'Passed' : 'Failed' });

  blocks.push({ type: 'h2', text: t.bySuite });
  const bySuite = new Map();
  for (const r of rows) {
    if (!bySuite.has(r.suite_path)) bySuite.set(r.suite_path, []);
    bySuite.get(r.suite_path).push(r);
  }
  blocks.push({
    type: 'table',
    columns: [
      { label: t.suite, width: 0.34 }, { label: t.total, width: 0.08, align: 'center' },
      { label: t.Passed, width: 0.09, align: 'center' }, { label: t.Failed, width: 0.09, align: 'center' },
      { label: t.Blocked, width: 0.1, align: 'center' }, { label: t.Skipped, width: 0.1, align: 'center' },
      { label: t['Not Run'], width: 0.1, align: 'center' }, { label: t.passRate, width: 0.1, align: 'center' },
    ],
    rows: [...bySuite.entries()].map(([name, list]) => {
      const x = summarize(list);
      return [name || '-', x.total, x.Passed, x.Failed, x.Blocked, x.Skipped, x['Not Run'], `${x.pass_rate}%`];
    }),
  });

  blocks.push({ type: 'h2', text: t.defects });
  const issues = rows.filter((r) => r.status === 'Failed' || r.status === 'Blocked' || r.approval_status === 'Rejected');
  if (!issues.length) blocks.push({ type: 'p', text: t.noDefects });
  else {
    blocks.push({
      type: 'table',
      columns: [
        { label: t.caseId, width: 0.12 }, { label: t.caseTitle, width: 0.28 }, { label: t.status, width: 0.11 },
        { label: t.defectRef, width: 0.13 }, { label: t.actualResult, width: 0.36 },
      ],
      rows: issues.map((r) => [r.case_key, r.title, st(t, r.status), r.defect_ref || '-', r.actual_result || '-']),
    });
  }

  blocks.push({ type: 'h2', text: t.details });
  blocks.push({
    type: 'table',
    columns: [
      { label: t.caseId, width: 0.1 }, { label: t.caseTitle, width: isUat ? 0.25 : 0.36 }, { label: t.priority, width: 0.09 },
      { label: t.result, width: isUat ? 0.1 : 0.11 }, { label: t.executedBy, width: isUat ? 0.13 : 0.15 }, { label: t.executedAt, width: isUat ? 0.17 : 0.19 },
      ...(isUat ? [{ label: t.approval, width: 0.16 }] : []),
    ],
    rows: rows.map((r) => [
      r.case_key, r.title, r.priority, st(t, r.status), r.executed_by_name || '-', f.dt(r.executed_at),
      ...(isUat ? [r.execution_id ? st(t, r.approval_status) : '-'] : []),
    ]),
  });

  if (opts.details) {
    for (const r of rows) {
      const c = getCase(r.case_id);
      const exec = r.execution_id ? executionDetails(r.plan_case_id)[0] : null;
      blocks.push({ type: 'h3', text: `${r.case_key} — ${r.title}`, status: r.status, statusText: t[r.status] });
      const kv = [[t.suite, r.suite_path]];
      if (c.objective) kv.push([t.objective, c.objective]);
      if (c.preconditions) kv.push([t.preconditions, c.preconditions]);
      if (c.requirement_ref) kv.push([t.requirement, c.requirement_ref]);
      if (exec) {
        kv.push([t.executedBy, `${exec.executed_by_name || '-'} · ${f.dt(exec.executed_at)}`]);
        if (exec.actual_result) kv.push([t.actualResult, exec.actual_result]);
        if (exec.defect_ref) kv.push([t.defectRef, exec.defect_ref]);
        if (exec.notes) kv.push([t.notes, exec.notes]);
        if (isUat) kv.push([t.approval, `${t[exec.approval_status]}${exec.approved_by_name ? ` · ${exec.approved_by_name} · ${f.dt(exec.approved_at)}` : ''}${exec.approval_note ? ` — ${exec.approval_note}` : ''}`]);
      } else kv.push([t.result, t.notExecuted]);
      blocks.push({ type: 'kv', rows: kv, compact: true });

      const steps = exec?.steps?.length ? exec.steps : c.steps;
      if (steps.length) {
        blocks.push({
          type: 'table', small: true,
          columns: [
            { label: t.stepNo, width: 0.05, align: 'center' }, { label: t.stepAction, width: 0.3 },
            { label: t.expected, width: 0.27 }, { label: t.actualResult, width: 0.26 }, { label: t.stepResult, width: 0.12 },
          ],
          rows: steps.map((x) => [x.step_no, x.action, x.expected_result || '-', x.actual_result || '-', x.status ? st(t, x.status) : '-']),
        });
      }
      if (exec && opts.evidence) {
        const items = evidenceItems(exec.attachments);
        blocks.push({ type: 'evidence', label: t.evidence, empty: t.noEvidence, otherLabel: t.otherFiles, items });
      }
    }
  }

  blocks.push({ type: 'h2', text: t.signoff });
  blocks.push(signatureBlock(t, f, latestSignoffs(planId), project));

  return { title: `${isUat ? 'UAT' : 'SIT'} Report - ${project.prefix} - ${plan.name}`, blocks };
}

function bastReport(planId, t, f, opts) {
  const plan = getPlan(planId);
  const project = getProject(plan.project_id);
  const rows = planCases(planId);
  const s = summarize(rows);
  const signoffs = latestSignoffs(planId);
  const client = signoffs.client;
  const date = client ? f.parse(client.signed_at) : new Date();
  const blocks = [];

  blocks.push({ type: 'title', text: t.bastTitle.toUpperCase(), subtitle: t.bastSubtitle, center: true,
    meta: opts.docNo ? `${t.docNo}: ${opts.docNo}` : '' });
  blocks.push({ type: 'p', text: t.bastOpening(f.weekday(date), f.dLong(date)) });

  const partyBlock = (num, s, fallbackCompany, partyName) => {
    blocks.push({ type: 'kv', numbered: num, rows: [
      [t.name, s?.signer_name || '.................................'],
      [t.titleRole, s?.signer_title || '.................................'],
      [t.company, s?.company || fallbackCompany || '.................................'],
    ] });
    blocks.push({ type: 'p', text: t.actingFor(s?.company || fallbackCompany, partyName), indent: true });
  };
  partyBlock(1, signoffs.vendor, project.vendor_name, t.firstParty);
  partyBlock(2, client, project.client_name, t.secondParty);

  blocks.push({ type: 'p', text: t.bastHandover });
  blocks.push({ type: 'kv', rows: [
    [t.project, `${project.name} (${project.prefix})`],
    [t.build, plan.build_version || '-'],
    [t.scope, plan.name],
    [t.environment, plan.environment],
    [t.period, `${f.d(plan.start_date)} – ${f.d(plan.end_date)}`],
    [t.uatResult, t.resultLine(s)],
    [t.decision, client ? t[client.decision] : t.Pending],
  ] });
  blocks.push({ type: 'p', text: t.bastTested });
  let statement = t.bastPending;
  if (client?.decision === 'Approved') statement = t.bastAccepted;
  else if (client?.decision === 'Approved with notes') statement = t.bastAcceptedNotes(client.note);
  else if (client?.decision === 'Rejected') statement = t.bastRejected(client.note);
  blocks.push({ type: 'p', text: statement, bold: true });
  blocks.push({ type: 'p', text: t.bastClosing });

  const sig = signatureBlock(t, f, signoffs, project);
  sig.parties[0].label = t.firstParty;
  sig.parties[1].label = t.secondParty;
  blocks.push(sig);

  blocks.push({ type: 'pagebreak' });
  blocks.push({ type: 'h2', text: t.attachment });
  blocks.push(...summaryBlocks(t, s, true));
  blocks.push({
    type: 'table',
    columns: [
      { label: t.caseId, width: 0.12 }, { label: t.caseTitle, width: 0.4 }, { label: t.suite, width: 0.22 },
      { label: t.result, width: 0.13 }, { label: t.approval, width: 0.13 },
    ],
    rows: rows.map((r) => [r.case_key, r.title, r.suite_path, st(t, r.status), r.execution_id ? st(t, r.approval_status) : '-']),
  });

  return { title: `BAST - ${project.prefix} - ${plan.name}`, blocks };
}

export function buildReport({ planId, type, lang, user, details = true, evidence = true, docNo = '' }) {
  const t = STRINGS[lang] || STRINGS.id;
  const f = formatters(t);
  const opts = { user, details, evidence, docNo };
  const report = type === 'bast' ? bastReport(planId, t, f, opts) : testReport(type, planId, t, f, opts);
  report.lang = lang;
  report.t = t;
  return report;
}
