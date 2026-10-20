import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { all, get, run, tx, hashPassword, HttpError, UPLOAD_DIR } from './db.js';
import { login, logout, changePassword, requireAuth, requireRole } from './auth.js';
import {
  ah, toInt, getProject, getSuite, getPlan, getCase, createSuite, moveSuite, copySuite, deleteSuite,
  normalizeCase, normalizeSteps, createCase, updateCase, copyCase, moveCase, assertNotExecuted,
  planCases, summarize, addCasesToPlan, casesInSuites, executionDetails, suitePaths, removeAttachmentFile,
  attachmentFilesFor, PRIORITIES, TEST_TYPES, EXECUTION_TYPES, CASE_STATUSES, RESULT_STATUSES, ENVIRONMENTS,
} from './services.js';
import { importCases, exportCases, toCsv, toXlsx, TEMPLATE_ROWS, suiteBelongs } from './importExport.js';
import { renderReport } from './reports/index.js';
import { ai } from './aiRoutes.js';

const MAX_UPLOAD_MB = toInt(process.env.MAX_UPLOAD_MB) || 25;

const evidenceUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 30 },
});
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// multer decodes original names as latin1
const originalName = (f) => Buffer.from(f.originalname, 'latin1').toString('utf8');

const tester = requireRole('tester');
const approver = requireRole('client');
const admin = requireRole();
const anyRole = requireRole('tester', 'client');

const ids = (v) => (Array.isArray(v) ? v : []).map(toInt).filter(Boolean);
const placeholders = (arr) => arr.map(() => '?').join(',');

export const api = express.Router();
api.use(express.json({ limit: '2mb' }));

/* ------------------------------------------------------------------ auth */

api.post('/auth/login', ah(login));
api.post('/auth/logout', ah(logout));
api.use(requireAuth);
api.get('/auth/me', (req, res) => res.json(req.user));
api.put('/auth/password', ah(changePassword));

api.get('/meta', (req, res) => res.json({
  priorities: PRIORITIES, test_types: TEST_TYPES, execution_types: EXECUTION_TYPES,
  case_statuses: CASE_STATUSES, result_statuses: RESULT_STATUSES, environments: ENVIRONMENTS,
}));

/* ------------------------------------------------------------------ users */

api.get('/users', (req, res) => {
  res.json(all('SELECT id, username, full_name, email, role, company, title, active, created_at FROM users ORDER BY full_name'));
});

api.post('/users', admin, ah((req, res) => {
  const b = req.body;
  if (!b.username || !b.full_name || !b.password) throw new HttpError(400, 'Username, full name and password are required');
  if (String(b.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  if (get('SELECT 1 FROM users WHERE username = ?', b.username)) throw new HttpError(409, 'Username already exists');
  const role = ['admin', 'tester', 'client'].includes(b.role) ? b.role : 'tester';
  const r = run('INSERT INTO users (username, full_name, email, role, company, title, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    String(b.username).trim(), b.full_name, b.email, role, b.company, b.title, hashPassword(String(b.password)));
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));

api.put('/users/:id', admin, ah((req, res) => {
  const b = req.body;
  const id = toInt(req.params.id);
  const user = get('SELECT * FROM users WHERE id = ?', id);
  if (!user) throw new HttpError(404, 'User not found');
  const role = ['admin', 'tester', 'client'].includes(b.role) ? b.role : user.role;
  const active = b.active === undefined ? user.active : (b.active ? 1 : 0);
  if (id === req.user.id && (role !== 'admin' || !active)) throw new HttpError(400, 'You cannot demote or deactivate yourself');
  run('UPDATE users SET full_name = ?, email = ?, role = ?, company = ?, title = ?, active = ? WHERE id = ?',
    b.full_name || user.full_name, b.email ?? user.email, role, b.company ?? user.company, b.title ?? user.title, active, id);
  if (b.password) {
    if (String(b.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(b.password)), id);
    run('DELETE FROM sessions WHERE user_id = ?', id);
  }
  if (!active) run('DELETE FROM sessions WHERE user_id = ?', id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ projects */

api.get('/projects', (req, res) => {
  res.json(all(
    `SELECT p.*,
       (SELECT COUNT(*) FROM test_cases c WHERE c.project_id = p.id) AS case_count,
       (SELECT COUNT(*) FROM suites s WHERE s.project_id = p.id) AS suite_count,
       (SELECT COUNT(*) FROM test_plans t WHERE t.project_id = p.id) AS plan_count
     FROM projects p ORDER BY p.name`
  ));
});

function projectBody(b) {
  const name = String(b.name || '').trim();
  const prefix = String(b.prefix || '').trim().toUpperCase();
  if (!name) throw new HttpError(400, 'Project name is required');
  if (!/^[A-Z0-9_]{2,10}$/.test(prefix)) throw new HttpError(400, 'Prefix must be 2-10 letters, digits or underscore (e.g. CBS)');
  return { name, prefix, description: b.description || null, client_name: b.client_name || null, vendor_name: b.vendor_name || null };
}

api.post('/projects', admin, ah((req, res) => {
  const p = projectBody(req.body);
  if (get('SELECT 1 FROM projects WHERE prefix = ?', p.prefix)) throw new HttpError(409, 'Prefix already used by another project');
  const r = run('INSERT INTO projects (name, prefix, description, client_name, vendor_name) VALUES (?, ?, ?, ?, ?)',
    p.name, p.prefix, p.description, p.client_name, p.vendor_name);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));

api.put('/projects/:id', admin, ah((req, res) => {
  const id = toInt(req.params.id);
  getProject(id);
  const p = projectBody(req.body);
  if (get('SELECT 1 FROM projects WHERE prefix = ? AND id != ?', p.prefix, id)) throw new HttpError(409, 'Prefix already used by another project');
  run('UPDATE projects SET name = ?, prefix = ?, description = ?, client_name = ?, vendor_name = ? WHERE id = ?',
    p.name, p.prefix, p.description, p.client_name, p.vendor_name, id);
  res.json({ ok: true });
}));

api.delete('/projects/:id', admin, ah((req, res) => {
  const id = toInt(req.params.id);
  getProject(id);
  const files = attachmentFilesFor('pc.plan_id IN (SELECT id FROM test_plans WHERE project_id = ?)', id);
  run('DELETE FROM projects WHERE id = ?', id);
  files.forEach(removeAttachmentFile);
  res.json({ ok: true });
}));

/** Suite tree plus lightweight case list for the specification view. */
api.get('/projects/:id/tree', ah((req, res) => {
  const id = toInt(req.params.id);
  const project = getProject(id);
  const suites = all('SELECT id, parent_id, name, description, sort FROM suites WHERE project_id = ? ORDER BY sort, id', id);
  const cases = all(
    `SELECT id, suite_id, case_key, title, priority, status, test_type, execution_type, version, sort
     FROM test_cases WHERE project_id = ? ORDER BY sort, id`, id
  );
  res.json({ project, suites, cases });
}));

api.get('/projects/:id/search', ah((req, res) => {
  const id = toInt(req.params.id);
  const q = `%${String(req.query.q || '').trim()}%`;
  const paths = suitePaths(id);
  const rows = all(
    `SELECT id, suite_id, case_key, title, priority, status FROM test_cases
     WHERE project_id = ? AND (case_key LIKE ? OR title LIKE ? OR tags LIKE ? OR requirement_ref LIKE ?)
     ORDER BY case_key LIMIT 200`, id, q, q, q, q
  );
  rows.forEach((r) => { r.suite_path = paths.get(r.suite_id); });
  res.json(rows);
}));

/* ------------------------------------------------------------------ suites */

api.post('/suites', tester, ah((req, res) => {
  const projectId = toInt(req.body.project_id);
  getProject(projectId);
  const id = createSuite(projectId, toInt(req.body.parent_id), req.body.name, req.body.description);
  res.status(201).json({ id });
}));

api.put('/suites/:id', tester, ah((req, res) => {
  const id = toInt(req.params.id);
  getSuite(id);
  const name = String(req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Suite name is required');
  run('UPDATE suites SET name = ?, description = ? WHERE id = ?', name, req.body.description || null, id);
  res.json({ ok: true });
}));

api.post('/suites/:id/move', tester, ah((req, res) => {
  moveSuite(toInt(req.params.id), toInt(req.body.parent_id));
  res.json({ ok: true });
}));

api.post('/suites/:id/copy', tester, ah((req, res) => {
  const id = copySuite(toInt(req.params.id), toInt(req.body.parent_id), req.user.id);
  res.status(201).json({ id });
}));

api.delete('/suites/:id', tester, ah((req, res) => {
  const id = toInt(req.params.id);
  getSuite(id);
  deleteSuite(id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ test cases */

api.get('/cases/:id', ah((req, res) => {
  const c = getCase(toInt(req.params.id));
  c.suite_path = suitePaths(c.project_id).get(c.suite_id);
  c.plans = all(
    `SELECT t.id, t.name, t.environment FROM plan_cases pc JOIN test_plans t ON t.id = pc.plan_id
     WHERE pc.case_id = ? ORDER BY t.id DESC`, c.id
  );
  res.json(c);
}));

api.post('/cases', tester, ah((req, res) => {
  const suiteId = toInt(req.body.suite_id);
  const id = createCase(suiteId, normalizeCase(req.body), normalizeSteps(req.body.steps), req.user.id);
  res.status(201).json({ id });
}));

api.put('/cases/:id', tester, ah((req, res) => {
  const id = toInt(req.params.id);
  const changed = updateCase(id, normalizeCase(req.body), normalizeSteps(req.body.steps), req.user.id);
  res.json({ ok: true, changed });
}));

api.delete('/cases/:id', tester, ah((req, res) => {
  const id = toInt(req.params.id);
  getCase(id);
  assertNotExecuted([id], 'This test case');
  run('DELETE FROM test_cases WHERE id = ?', id);
  res.json({ ok: true });
}));

/** Copy, move or delete several cases at once. */
api.post('/cases/bulk', tester, ah((req, res) => {
  const caseIds = ids(req.body.case_ids);
  const target = toInt(req.body.target_suite_id);
  if (!caseIds.length) throw new HttpError(400, 'Select at least one test case');
  const created = [];
  tx(() => {
    switch (req.body.action) {
      case 'copy':
        if (!target) throw new HttpError(400, 'Choose a target suite');
        caseIds.forEach((id) => created.push(copyCase(id, target, req.user.id)));
        break;
      case 'move':
        if (!target) throw new HttpError(400, 'Choose a target suite');
        caseIds.forEach((id) => moveCase(id, target));
        break;
      case 'delete':
        assertNotExecuted(caseIds, 'One of the selected test cases');
        run(`DELETE FROM test_cases WHERE id IN (${placeholders(caseIds)})`, ...caseIds);
        break;
      default:
        throw new HttpError(400, 'Unknown action');
    }
  });
  res.json({ ok: true, count: caseIds.length, created });
}));

/* ------------------------------------------------------------------ import / export */

api.post('/projects/:id/import', tester, importUpload.single('file'), ah(async (req, res) => {
  const projectId = toInt(req.params.id);
  getProject(projectId);
  if (!req.file) throw new HttpError(400, 'Choose a .xlsx or .csv file');
  if (!/\.(xlsx|csv|txt)$/i.test(req.file.originalname)) throw new HttpError(400, 'Only .xlsx and .csv files are supported');
  const defaultSuiteId = toInt(req.body.suite_id);
  if (!suiteBelongs(projectId, defaultSuiteId)) throw new HttpError(400, 'Suite belongs to another project');
  const result = await importCases({
    projectId, buffer: req.file.buffer, filename: req.file.originalname, defaultSuiteId, userId: req.user.id,
  });
  res.json(result);
}));

async function sendSheet(res, rows, format, basename) {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${basename}.csv"`);
    return res.send(toCsv(rows));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${basename}.xlsx"`);
  res.send(await toXlsx(rows));
}

api.get('/projects/:id/export', ah(async (req, res) => {
  const projectId = toInt(req.params.id);
  const project = getProject(projectId);
  const suiteId = toInt(req.query.suite_id);
  if (!suiteBelongs(projectId, suiteId)) throw new HttpError(400, 'Suite belongs to another project');
  await sendSheet(res, exportCases(projectId, suiteId), req.query.format, `${project.prefix}-test-cases`);
}));

api.get('/import-template', ah(async (req, res) => {
  await sendSheet(res, TEMPLATE_ROWS, req.query.format, 'test-case-import-template');
}));

/* ------------------------------------------------------------------ test plans */

api.get('/projects/:id/plans', ah((req, res) => {
  const projectId = toInt(req.params.id);
  getProject(projectId);
  const plans = all(
    `SELECT t.*, u.full_name AS created_by_name FROM test_plans t LEFT JOIN users u ON u.id = t.created_by
     WHERE t.project_id = ? ORDER BY t.status, t.id DESC`, projectId
  );
  for (const p of plans) p.summary = summarize(planCases(p.id));
  res.json(plans);
}));

function planBody(b) {
  const name = String(b.name || '').trim();
  if (!name) throw new HttpError(400, 'Test plan name is required');
  const environment = ENVIRONMENTS.includes(b.environment) ? b.environment : 'SIT';
  if (b.start_date && b.end_date && b.start_date > b.end_date) throw new HttpError(400, 'End date must be after start date');
  return {
    name, environment, description: b.description || null, build_version: b.build_version || null,
    start_date: b.start_date || null, end_date: b.end_date || null,
    status: b.status === 'Closed' ? 'Closed' : 'Active',
  };
}

api.post('/plans', tester, ah((req, res) => {
  const projectId = toInt(req.body.project_id);
  getProject(projectId);
  const p = planBody(req.body);
  const id = tx(() => {
    const planId = Number(run(
      `INSERT INTO test_plans (project_id, name, description, environment, build_version, start_date, end_date, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId, p.name, p.description, p.environment, p.build_version, p.start_date, p.end_date, p.status, req.user.id
    ).lastInsertRowid);
    const suiteIds = ids(req.body.suite_ids);
    suiteIds.forEach((s) => { if (getSuite(s).project_id !== projectId) throw new HttpError(400, 'Suite belongs to another project'); });
    addCasesToPlan(planId, [...casesInSuites(suiteIds), ...ids(req.body.case_ids)]);
    return planId;
  });
  res.status(201).json({ id });
}));

api.get('/plans/:id', ah((req, res) => {
  const plan = getPlan(toInt(req.params.id));
  const cases = planCases(plan.id);
  plan.project = getProject(plan.project_id);
  plan.cases = cases;
  plan.summary = summarize(cases);
  plan.signoffs = all('SELECT * FROM signoffs WHERE plan_id = ? ORDER BY id', plan.id);
  res.json(plan);
}));

api.put('/plans/:id', tester, ah((req, res) => {
  const id = toInt(req.params.id);
  getPlan(id);
  const p = planBody(req.body);
  run(`UPDATE test_plans SET name = ?, description = ?, environment = ?, build_version = ?, start_date = ?, end_date = ?, status = ?
       WHERE id = ?`, p.name, p.description, p.environment, p.build_version, p.start_date, p.end_date, p.status, id);
  res.json({ ok: true });
}));

api.delete('/plans/:id', tester, ah((req, res) => {
  const id = toInt(req.params.id);
  getPlan(id);
  const files = attachmentFilesFor('pc.plan_id = ?', id);
  run('DELETE FROM test_plans WHERE id = ?', id);
  files.forEach(removeAttachmentFile);
  res.json({ ok: true });
}));

api.post('/plans/:id/cases', tester, ah((req, res) => {
  const plan = getPlan(toInt(req.params.id));
  const suiteIds = ids(req.body.suite_ids);
  suiteIds.forEach((s) => { if (getSuite(s).project_id !== plan.project_id) throw new HttpError(400, 'Suite belongs to another project'); });
  const added = addCasesToPlan(plan.id, [...casesInSuites(suiteIds), ...ids(req.body.case_ids)]);
  res.json({ added });
}));

api.post('/plans/:id/cases/remove', tester, ah((req, res) => {
  const planId = toInt(req.params.id);
  const pcIds = ids(req.body.plan_case_ids);
  if (!pcIds.length) throw new HttpError(400, 'Select at least one test case');
  const files = attachmentFilesFor(`pc.plan_id = ? AND pc.id IN (${placeholders(pcIds)})`, planId, ...pcIds);
  const r = run(`DELETE FROM plan_cases WHERE plan_id = ? AND id IN (${placeholders(pcIds)})`, planId, ...pcIds);
  files.forEach(removeAttachmentFile);
  res.json({ removed: Number(r.changes) });
}));

api.post('/plans/:id/assign', tester, ah((req, res) => {
  const planId = toInt(req.params.id);
  const pcIds = ids(req.body.plan_case_ids);
  const userId = toInt(req.body.user_id);
  if (userId && !get('SELECT 1 FROM users WHERE id = ?', userId)) throw new HttpError(400, 'User not found');
  const r = run(`UPDATE plan_cases SET assigned_to = ? WHERE plan_id = ? AND id IN (${placeholders(pcIds) || 'NULL'})`, userId, planId, ...pcIds);
  res.json({ updated: Number(r.changes) });
}));

/* ------------------------------------------------------------------ execution */

function getPlanCase(id) {
  const pc = get(
    `SELECT pc.*, t.project_id, t.environment, t.status AS plan_status FROM plan_cases pc
     JOIN test_plans t ON t.id = pc.plan_id WHERE pc.id = ?`, id
  );
  if (!pc) throw new HttpError(404, 'Test case is not in this plan');
  return pc;
}

api.get('/plan-cases/:id', ah((req, res) => {
  const pc = getPlanCase(toInt(req.params.id));
  const c = getCase(pc.case_id);
  c.suite_path = suitePaths(c.project_id).get(c.suite_id);
  const assignee = pc.assigned_to && get('SELECT full_name FROM users WHERE id = ?', pc.assigned_to);
  res.json({ plan_case: { ...pc, assigned_name: assignee?.full_name || null }, case: c, executions: executionDetails(pc.id) });
}));

function saveAttachments(executionId, files, userId) {
  for (const f of files || []) {
    run('INSERT INTO attachments (execution_id, stored_name, original_name, mime_type, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
      executionId, f.filename, originalName(f), f.mimetype, f.size, userId);
  }
}

const cleanupUploads = (req) => (req.files || []).forEach((f) => removeAttachmentFile(f.filename));

/** Records a run. Multipart: field "data" (JSON) plus "evidence" files. */
api.post('/plan-cases/:id/executions', tester, evidenceUpload.array('evidence'), ah((req, res) => {
  try {
    const pc = getPlanCase(toInt(req.params.id));
    if (pc.plan_status === 'Closed') throw new HttpError(400, 'This test plan is closed. Reopen it to record results.');
    const b = JSON.parse(req.body.data || '{}');
    if (!RESULT_STATUSES.includes(b.status)) throw new HttpError(400, 'Choose a result: Passed, Failed, Blocked or Skipped');
    if (b.status === 'Failed' && !String(b.actual_result || '').trim()) throw new HttpError(400, 'Describe the actual result for a failed test');
    const c = getCase(pc.case_id);
    const stepResults = Array.isArray(b.steps) ? b.steps : [];
    const id = tx(() => {
      const execId = Number(run(
        `INSERT INTO executions (plan_case_id, case_version, status, actual_result, notes, defect_ref, duration_minutes, executed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        pc.id, c.version, b.status, b.actual_result || null, b.notes || null, b.defect_ref || null,
        toInt(b.duration_minutes), req.user.id
      ).lastInsertRowid);
      for (const s of c.steps) {
        const r = stepResults.find((x) => toInt(x.step_no) === s.step_no) || {};
        run(`INSERT INTO execution_steps (execution_id, step_no, action, expected_result, status, actual_result)
             VALUES (?, ?, ?, ?, ?, ?)`,
          execId, s.step_no, s.action, s.expected_result,
          [...RESULT_STATUSES, 'Not Run'].includes(r.status) ? r.status : null, r.actual_result || null);
      }
      saveAttachments(execId, req.files, req.user.id);
      return execId;
    });
    res.status(201).json({ id });
  } catch (e) {
    cleanupUploads(req);
    throw e;
  }
}));

function getExecution(id) {
  const e = get(
    `SELECT e.*, pc.plan_id, t.status AS plan_status FROM executions e JOIN plan_cases pc ON pc.id = e.plan_case_id
     JOIN test_plans t ON t.id = pc.plan_id WHERE e.id = ?`, id
  );
  if (!e) throw new HttpError(404, 'Execution not found');
  return e;
}

api.post('/executions/:id/attachments', tester, evidenceUpload.array('evidence'), ah((req, res) => {
  try {
    const e = getExecution(toInt(req.params.id));
    if (!req.files?.length) throw new HttpError(400, 'Choose at least one file');
    saveAttachments(e.id, req.files, req.user.id);
    res.status(201).json({ ok: true });
  } catch (err) {
    cleanupUploads(req);
    throw err;
  }
}));

api.delete('/executions/:id', tester, ah((req, res) => {
  const e = getExecution(toInt(req.params.id));
  if (e.approval_status === 'Approved') throw new HttpError(400, 'An approved result cannot be deleted');
  const files = all('SELECT stored_name FROM attachments WHERE execution_id = ?', e.id).map((r) => r.stored_name);
  run('DELETE FROM executions WHERE id = ?', e.id);
  files.forEach(removeAttachmentFile);
  res.json({ ok: true });
}));

/** Client (UAT approver) accepts or rejects a recorded result. */
api.post('/executions/:id/approval', approver, ah((req, res) => {
  const e = getExecution(toInt(req.params.id));
  const decision = req.body.decision;
  if (!['Approved', 'Rejected', 'Pending'].includes(decision)) throw new HttpError(400, 'Decision must be Approved, Rejected or Pending');
  if (decision === 'Rejected' && !String(req.body.note || '').trim()) throw new HttpError(400, 'Give a reason when rejecting');
  run(`UPDATE executions SET approval_status = ?, approved_by = ?, approved_at = CASE WHEN ? = 'Pending' THEN NULL ELSE CURRENT_TIMESTAMP END,
       approval_note = ? WHERE id = ?`, decision, decision === 'Pending' ? null : req.user.id, decision, req.body.note || null, e.id);
  res.json({ ok: true });
}));

/** Approve every latest Passed result in a plan in one tap. */
api.post('/plans/:id/approve-passed', approver, ah((req, res) => {
  const planId = toInt(req.params.id);
  getPlan(planId);
  const r = run(
    `UPDATE executions SET approval_status = 'Approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, approval_note = ?
     WHERE status = 'Passed' AND approval_status = 'Pending'
       AND id IN (SELECT MAX(e.id) FROM executions e JOIN plan_cases pc ON pc.id = e.plan_case_id WHERE pc.plan_id = ? GROUP BY e.plan_case_id)`,
    req.user.id, req.body.note || null, planId
  );
  res.json({ approved: Number(r.changes) });
}));

api.get('/attachments/:id', ah((req, res) => {
  const a = get('SELECT * FROM attachments WHERE id = ?', toInt(req.params.id));
  if (!a) throw new HttpError(404, 'Attachment not found');
  const file = path.join(UPLOAD_DIR, path.basename(a.stored_name));
  if (!fs.existsSync(file)) throw new HttpError(404, 'File missing on server');
  const inline = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|video\/(mp4|webm)|text\/plain)$/.test(a.mime_type || '') && !req.query.download;
  res.setHeader('Content-Type', inline ? a.mime_type : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.original_name)}`);
  fs.createReadStream(file).pipe(res);
}));

api.delete('/attachments/:id', tester, ah((req, res) => {
  const a = get('SELECT a.*, e.approval_status FROM attachments a JOIN executions e ON e.id = a.execution_id WHERE a.id = ?', toInt(req.params.id));
  if (!a) throw new HttpError(404, 'Attachment not found');
  if (a.approval_status === 'Approved') throw new HttpError(400, 'Evidence of an approved result cannot be deleted');
  run('DELETE FROM attachments WHERE id = ?', a.id);
  removeAttachmentFile(a.stored_name);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ sign-off */

api.post('/plans/:id/signoffs', anyRole, ah((req, res) => {
  const planId = toInt(req.params.id);
  getPlan(planId);
  const b = req.body;
  const party = b.party === 'vendor' ? 'vendor' : 'client';
  if (party === 'vendor' && !['admin', 'tester'].includes(req.user.role)) throw new HttpError(403, 'Only the vendor team can sign as vendor');
  if (party === 'client' && !['admin', 'client'].includes(req.user.role)) throw new HttpError(403, 'Only the client can sign as client');
  const decision = ['Approved', 'Approved with notes', 'Rejected'].includes(b.decision) ? b.decision : null;
  if (!decision) throw new HttpError(400, 'Choose a decision');
  if (!String(b.signer_name || '').trim()) throw new HttpError(400, 'Signer name is required');
  const r = run(
    `INSERT INTO signoffs (plan_id, party, signer_name, signer_title, company, decision, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    planId, party, String(b.signer_name).trim(), b.signer_title || null, b.company || null, decision, b.note || null, req.user.id
  );
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));

api.delete('/signoffs/:id', anyRole, ah((req, res) => {
  const s = get('SELECT * FROM signoffs WHERE id = ?', toInt(req.params.id));
  if (!s) throw new HttpError(404, 'Sign-off not found');
  if (req.user.role !== 'admin' && s.user_id !== req.user.id) throw new HttpError(403, 'Only the signer or an admin can withdraw a sign-off');
  run('DELETE FROM signoffs WHERE id = ?', s.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ reports */

api.get('/plans/:id/report', ah(async (req, res) => {
  await renderReport(req, res, toInt(req.params.id));
}));

/* ------------------------------------------------------------------ AI test case generator, settings, Jira */

api.use(ai);
