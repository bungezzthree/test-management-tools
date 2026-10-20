import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run, tx, HttpError, UPLOAD_DIR } from '../db.js';
import {
  ENVIRONMENTS, RESULT_STATUSES, getCase, getPlan, normalizeCase, normalizeSteps, createCase, updateCase, moveCase,
  ensureSuitePath,
} from '../services.js';
import { suitePathFor, refFor } from './junit.js';

export const MAX_ITEMS = 5000;
const s = (v, max = 500) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

const STATUS_ALIASES = {
  Passed: ['passed', 'pass', 'passing', 'success', 'successful', 'ok'],
  Failed: ['failed', 'fail', 'failure', 'error', 'errored', 'broken', 'timedout'],
  Skipped: ['skipped', 'skip', 'pending', 'ignored', 'disabled', 'todo', 'notrun'],
  Blocked: ['blocked'],
};
export function mapStatus(value) {
  const v = String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return Object.keys(STATUS_ALIASES).find((k) => STATUS_ALIASES[k].includes(v)) || null;
}

/** Project by numeric id or by prefix (so CI scripts can use /projects/CBS/automation/...). */
export function resolveProject(ref) {
  const row = /^\d+$/.test(ref)
    ? get('SELECT * FROM projects WHERE id = ?', Number(ref))
    : get('SELECT * FROM projects WHERE prefix = ? COLLATE NOCASE', ref);
  if (!row) throw new HttpError(404, `Project "${ref}" not found`);
  return row;
}

class DryRun extends Error {}

/** Runs fn in a transaction; with dryRun the work is rolled back so the report shows what would happen. */
function maybeDry(dryRun, fn) {
  try {
    return tx(() => {
      const r = fn();
      if (dryRun) throw Object.assign(new DryRun(), { result: r });
      return r;
    });
  } catch (e) {
    if (e instanceof DryRun) return e.result;
    throw e;
  }
}

/* ------------------------------------------------------------------ spec sync */

const OPTIONAL_FIELDS = ['objective', 'preconditions', 'postconditions', 'priority', 'test_type', 'requirement_ref', 'tags', 'estimated_minutes'];

/**
 * Creates or updates test cases from the test code. Cases are matched by automation_ref, so running the sync on every
 * build never duplicates anything. A case that already exists manually can be linked by passing its case_key.
 */
export function syncCases(project, userId, body) {
  const input = Array.isArray(body.cases) ? body.cases : null;
  if (!input) throw new HttpError(400, 'Send {"cases": [...]} with at least automation_ref and title for each test');
  if (input.length > MAX_ITEMS) throw new HttpError(413, `Send at most ${MAX_ITEMS} test cases per request`);
  const root = s(body.suite_root ?? 'Automation', 200);
  const out = { created: 0, updated: 0, unchanged: 0, linked: 0, obsoleted: 0, errors: [], cases: [] };

  return maybeDry(Boolean(body.dry_run), () => {
    const seen = new Set();
    input.forEach((c, index) => {
      const ref = s(c?.automation_ref);
      try {
        if (!ref) throw new HttpError(400, 'automation_ref is required');
        if (seen.has(ref)) throw new HttpError(400, `automation_ref "${ref}" appears more than once in this request`);
        seen.add(ref);

        let existing = get('SELECT id FROM test_cases WHERE project_id = ? AND automation_ref = ?', project.id, ref);
        let linked = false;
        if (!existing && s(c.case_key)) {
          existing = get('SELECT id, automation_ref FROM test_cases WHERE project_id = ? AND case_key = ?', project.id, s(c.case_key));
          if (!existing) throw new HttpError(404, `case_key "${c.case_key}" not found in this project`);
          if (existing.automation_ref && existing.automation_ref !== ref) throw new HttpError(409, `${c.case_key} is already linked to ${existing.automation_ref}`);
          linked = true;
        }

        const suitePath = s(c.suite, 500) || null;
        const targetSuite = () => ensureSuitePath(project.id, [root, suitePath].filter(Boolean).join(' / ') || 'Automation');
        const stepsGiven = Array.isArray(c.steps);

        if (!existing) {
          const title = s(c.title, 300) || ref.split(/[#.]/).pop();
          const data = normalizeCase({ ...c, title, execution_type: 'Automated', status: c.status || 'Ready', automation_ref: ref });
          const id = createCase(targetSuite(), data, normalizeSteps(c.steps), userId);
          out.created++;
          out.cases.push({ automation_ref: ref, case_key: getCase(id).case_key, action: 'created' });
          return;
        }

        const cur = getCase(existing.id);
        const merged = { title: s(c.title, 300) || cur.title };
        for (const f of OPTIONAL_FIELDS) merged[f] = c[f] === undefined ? cur[f] : c[f];
        merged.execution_type = 'Automated';
        merged.status = cur.status === 'Obsolete' ? 'Ready' : (c.status || cur.status); // reappearing in code revives the case
        merged.automation_ref = ref;
        const changed = updateCase(cur.id, normalizeCase(merged), stepsGiven ? normalizeSteps(c.steps) : cur.steps, userId);
        let moved = false;
        if (suitePath) {
          const suiteId = targetSuite();
          if (suiteId !== cur.suite_id) { moveCase(cur.id, suiteId); moved = true; }
        }
        const action = linked ? 'linked' : changed || moved ? 'updated' : 'unchanged';
        if (linked) out.linked++; else if (action === 'updated') out.updated++; else out.unchanged++;
        out.cases.push({ automation_ref: ref, case_key: cur.case_key, action });
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        out.errors.push({ index, automation_ref: ref || null, message: e.message });
      }
    });

    if (body.obsolete_missing && seen.size) {
      const stale = all("SELECT id, automation_ref FROM test_cases WHERE project_id = ? AND automation_ref IS NOT NULL AND status != 'Obsolete'", project.id)
        .filter((r) => !seen.has(r.automation_ref));
      for (const r of stale) run("UPDATE test_cases SET status = 'Obsolete', version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", r.id);
      out.obsoleted = stale.length;
    }
    out.dry_run = Boolean(body.dry_run);
    return out;
  });
}

/* ------------------------------------------------------------------ results */

function resolvePlan(project, userId, spec, build) {
  const p = typeof spec === 'string' ? { name: spec } : (spec || {});
  if (p.id !== undefined && p.id !== null && p.id !== '') {
    const plan = getPlan(Number(p.id));
    if (plan.project_id !== project.id) throw new HttpError(400, 'That test plan belongs to another project');
    return { plan, created: false };
  }
  const name = s(p.name, 200) || 'Automated tests';
  let plan = get('SELECT * FROM test_plans WHERE project_id = ? AND name = ? ORDER BY id DESC LIMIT 1', project.id, name);
  if (plan) {
    if (build && plan.build_version !== build) {
      run('UPDATE test_plans SET build_version = ? WHERE id = ?', build, plan.id);
      plan = { ...plan, build_version: build };
    }
    return { plan, created: false };
  }
  const env = ENVIRONMENTS.find((e) => e.toLowerCase() === s(p.environment).toLowerCase()) || 'SIT';
  const today = new Date().toISOString().slice(0, 10);
  const id = Number(run(
    `INSERT INTO test_plans (project_id, name, description, environment, build_version, start_date, end_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    project.id, name, s(p.description, 2000) || 'Created by test automation', env, s(p.build_version, 100) || build || null,
    s(p.start_date, 10) || today, s(p.end_date, 10) || today, userId).lastInsertRowid);
  return { plan: getPlan(id), created: true };
}

function writeTextAttachment(executionId, name, content, userId) {
  const stored = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.txt`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), content, 'utf8');
  run('INSERT INTO attachments (execution_id, stored_name, original_name, mime_type, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
    executionId, stored, name, 'text/plain', Buffer.byteLength(content), userId);
  return stored;
}

/**
 * Records automated results into a test plan. Items: { automation_ref | case_key, status, duration_ms | duration_seconds,
 * message, defect_ref, notes, title, suite, requirement_ref, tags, steps:[{step_no,status,actual_result}], output }.
 */
export function recordResults(project, userId, body) {
  const items = Array.isArray(body.results) ? body.results : null;
  if (!items?.length) throw new HttpError(400, 'Send {"results": [...]} with at least one result');
  if (items.length > MAX_ITEMS) throw new HttpError(413, `Send at most ${MAX_ITEMS} results per request`);
  const build = s(body.build, 100) || null;
  const ciUrl = s(body.ci_url, 1000) || null;
  const runId = s(body.run_id, 200) || null;
  const autoCreate = body.auto_create_cases !== false && body.auto_create !== false;
  const root = s(body.suite_root ?? 'Automation', 200);
  const written = []; // files to delete again if the transaction rolls back

  const summary = { Passed: 0, Failed: 0, Blocked: 0, Skipped: 0 };
  const out = { recorded: 0, created_cases: [], unmatched: [], duplicates: 0, errors: [] };

  try {
    const planInfo = maybeDry(Boolean(body.dry_run), () => {
      const { plan, created } = resolvePlan(project, userId, body.plan, build);
      if (plan.status === 'Closed') throw new HttpError(409, `Test plan "${plan.name}" is closed. Reopen it or use another plan name.`);
      out.plan_id = plan.id;
      out.plan_name = plan.name;
      out.plan_created = created;
      const seen = new Set();

      items.forEach((it, index) => {
        const label = s(it?.automation_ref) || s(it?.case_key) || `#${index + 1}`;
        try {
          const status = mapStatus(it?.status);
          if (!status || !RESULT_STATUSES.includes(status)) throw new HttpError(400, `Unknown status "${it?.status}". Use passed, failed, skipped or blocked.`);
          const ref = s(it.automation_ref) || (it.name ? refFor(s(it.classname), s(it.name)) : '');
          let tc = ref ? get('SELECT * FROM test_cases WHERE project_id = ? AND automation_ref = ?', project.id, ref) : null;
          if (!tc && s(it.case_key)) tc = get('SELECT * FROM test_cases WHERE project_id = ? AND case_key = ?', project.id, s(it.case_key));
          if (!tc) {
            if (!ref) throw new HttpError(400, 'Each result needs automation_ref (or case_key)');
            if (!autoCreate) {
              out.unmatched.push(ref);
              return;
            }
            const suitePath = s(it.suite, 500) || suitePathFor(it.classname);
            const data = normalizeCase({
              title: s(it.title, 300) || s(it.name, 300) || ref.split(/[#.]/).pop(),
              requirement_ref: it.requirement_ref, tags: it.tags, priority: it.priority,
              execution_type: 'Automated', status: 'Ready', automation_ref: ref,
            });
            const id = createCase(ensureSuitePath(project.id, [root, suitePath].filter(Boolean).join(' / ') || 'Automation'), data, [], userId);
            tc = get('SELECT * FROM test_cases WHERE id = ?', id);
            out.created_cases.push({ automation_ref: ref, case_key: tc.case_key });
          }
          if (tc.status === 'Obsolete') throw new HttpError(409, `${tc.case_key} is Obsolete; sync it again to revive it`);

          if (seen.has(tc.id)) throw new HttpError(400, 'This test appears more than once in the request');
          seen.add(tc.id);
          run('INSERT OR IGNORE INTO plan_cases (plan_id, case_id) VALUES (?, ?)', plan.id, tc.id);
          const pc = get('SELECT id FROM plan_cases WHERE plan_id = ? AND case_id = ?', plan.id, tc.id);
          if (runId && get('SELECT 1 FROM executions WHERE plan_case_id = ? AND run_id = ?', pc.id, runId)) {
            out.duplicates++;
            return;
          }

          const seconds = Number(it.duration_seconds);
          const ms = Number.isFinite(Number(it.duration_ms)) && it.duration_ms !== null && it.duration_ms !== ''
            ? Math.round(Number(it.duration_ms)) : (Number.isFinite(seconds) && it.duration_seconds != null ? Math.round(seconds * 1000) : null);
          const execId = Number(run(
            `INSERT INTO executions (plan_case_id, case_version, status, actual_result, notes, defect_ref, duration_ms,
               executed_by, source, build_ref, ci_url, run_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'automation', ?, ?, ?)`,
            pc.id, tc.version, status, s(it.message, 4000) || null, s(it.notes, 2000) || null, s(it.defect_ref, 200) || null,
            ms, userId, build, ciUrl, runId).lastInsertRowid);

          const stepResults = Array.isArray(it.steps) ? it.steps : [];
          for (const st of all('SELECT step_no, action, expected_result FROM test_steps WHERE case_id = ? ORDER BY step_no', tc.id)) {
            const sr = stepResults.find((x) => Number(x.step_no) === st.step_no);
            run(`INSERT INTO execution_steps (execution_id, step_no, action, expected_result, status, actual_result) VALUES (?, ?, ?, ?, ?, ?)`,
              execId, st.step_no, st.action, st.expected_result, sr ? mapStatus(sr.status) : (status === 'Passed' ? 'Passed' : null), s(sr?.actual_result, 2000) || null);
          }
          if (status === 'Failed' && s(it.output, 100000)) {
            written.push(writeTextAttachment(execId, 'test-output.txt', s(it.output, 100000), userId));
          }
          summary[status]++;
          out.recorded++;
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          out.errors.push({ index, test: label, message: e.message });
        }
      });
      return out;
    });
    planInfo.summary = summary;
    planInfo.dry_run = Boolean(body.dry_run);
    if (body.dry_run) written.splice(0).forEach(removeFile);
    return planInfo;
  } catch (e) {
    written.splice(0).forEach(removeFile);
    throw e;
  }
}

function removeFile(stored) {
  try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(stored))); } catch { /* already gone */ }
}
