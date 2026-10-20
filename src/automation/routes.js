import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { get, run, HttpError, UPLOAD_DIR } from '../db.js';
import { requireRole } from '../auth.js';
import { ah, toInt, getPlan } from '../services.js';
import { resolveProject, syncCases, recordResults } from './service.js';
import { parseJUnit, refFor, suitePathFor } from './junit.js';

/**
 * Endpoints for CI pipelines and test scripts. Authenticate with `Authorization: Bearer tdk_…`
 * (create a token under the user menu → API tokens). All routes need the admin or tester role.
 */
export const automation = express.Router();
const tester = requireRole('tester');
const json = express.json({ limit: '10mb' });

const reportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 50 } });
const evidenceUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`),
  }),
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 25) * 1024 * 1024, files: 30 },
});
const originalName = (f) => Buffer.from(f.originalname, 'latin1').toString('utf8');
const flag = (v, dflt) => (v === undefined || v === '' ? dflt : !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase()));
const asPlan = (b) => (b.plan_id ? { id: b.plan_id } : { name: b.plan_name, environment: b.environment, build_version: b.build, description: b.plan_description });

/** Create or update test cases from test code (idempotent, keyed by automation_ref). */
automation.put('/projects/:ref/automation/cases', json, tester, ah((req, res) => {
  const project = resolveProject(req.params.ref);
  res.json({ project: project.prefix, ...syncCases(project, req.user.id, req.body || {}) });
}));

/** Record automated results as JSON. */
automation.post('/projects/:ref/automation/results', json, tester, ah((req, res) => {
  const project = resolveProject(req.params.ref);
  const r = recordResults(project, req.user.id, req.body || {});
  res.status(r.dry_run ? 200 : 201).json({ project: project.prefix, ...r, plan_path: `/#/plans/${r.plan_id}` });
}));

/**
 * Upload one or more JUnit XML reports (multipart field "report"). Test cases are created from the report when missing.
 * Fields: plan_name | plan_id, environment, build, ci_url, run_id, suite_root, auto_create, dry_run.
 */
automation.post('/projects/:ref/automation/junit', tester, reportUpload.array('report'), ah((req, res) => {
  const project = resolveProject(req.params.ref);
  if (!req.files?.length) throw new HttpError(400, 'Attach the JUnit XML report as multipart field "report"');
  const results = [];
  for (const f of req.files) {
    try {
      for (const r of parseJUnit(f.buffer.toString('utf8'))) {
        results.push({
          automation_ref: r.properties?.['testdesk.ref'] || refFor(r.classname, r.name), classname: r.classname, name: r.name,
          status: r.status, duration_ms: r.duration_ms, message: r.message, output: r.output,
          defect_ref: r.properties?.['testdesk.defect'], requirement_ref: r.properties?.['testdesk.requirement'],
          tags: r.properties?.['testdesk.tags'], suite: suitePathFor(r.classname),
        });
      }
    } catch (e) {
      if (e instanceof HttpError) throw new HttpError(e.status, `${originalName(f)}: ${e.message}`);
      throw e;
    }
  }
  const b = req.body || {};
  const out = recordResults(project, req.user.id, {
    plan: asPlan(b), build: b.build, ci_url: b.ci_url, run_id: b.run_id, suite_root: b.suite_root,
    auto_create: flag(b.auto_create, true), dry_run: flag(b.dry_run, false), results,
  });
  res.status(out.dry_run ? 200 : 201).json({ project: project.prefix, files: req.files.length, ...out, plan_path: `/#/plans/${out.plan_id}` });
}));

/** Attach screenshots/logs to the latest automated run of one test in a plan (multipart: automation_ref | case_key, run_id?, evidence[]). */
automation.post('/plans/:id/automation/evidence', tester, evidenceUpload.array('evidence'), ah((req, res) => {
  const cleanup = () => (req.files || []).forEach((f) => { try { fs.unlinkSync(f.path); } catch { /* already gone */ } });
  try {
    const plan = getPlan(toInt(req.params.id));
    const { automation_ref: ref, case_key: key, run_id: runId } = req.body || {};
    if (!req.files?.length) throw new HttpError(400, 'Attach files as multipart field "evidence"');
    const tc = ref
      ? get('SELECT id, case_key FROM test_cases WHERE project_id = ? AND automation_ref = ?', plan.project_id, ref)
      : get('SELECT id, case_key FROM test_cases WHERE project_id = ? AND case_key = ?', plan.project_id, key || '');
    if (!tc) throw new HttpError(404, 'Test case not found. Send automation_ref or case_key.');
    const exec = get(
      `SELECT e.id FROM executions e JOIN plan_cases pc ON pc.id = e.plan_case_id
       WHERE pc.plan_id = ? AND pc.case_id = ? ${runId ? 'AND e.run_id = ?' : ''} ORDER BY e.id DESC LIMIT 1`,
      ...[plan.id, tc.id, ...(runId ? [runId] : [])]);
    if (!exec) throw new HttpError(404, `${tc.case_key} has no recorded result in this plan yet. Post the result first.`);
    for (const f of req.files) {
      run('INSERT INTO attachments (execution_id, stored_name, original_name, mime_type, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
        exec.id, f.filename, originalName(f), f.mimetype, f.size, req.user.id);
    }
    res.status(201).json({ ok: true, case_key: tc.case_key, execution_id: exec.id, files: req.files.length });
  } catch (e) {
    cleanup();
    throw e;
  }
}));
