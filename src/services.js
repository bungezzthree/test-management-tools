import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, HttpError, UPLOAD_DIR } from './db.js';

export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
export const TEST_TYPES = ['Functional', 'Negative', 'Regression', 'Integration', 'Performance', 'Security', 'Usability'];
export const EXECUTION_TYPES = ['Manual', 'Automated'];
export const CASE_STATUSES = ['Draft', 'Ready', 'Obsolete'];
export const RESULT_STATUSES = ['Passed', 'Failed', 'Blocked', 'Skipped'];
export const ENVIRONMENTS = ['SIT', 'UAT'];

/** Wraps a handler so thrown errors and rejected promises reach the error middleware. */
export const ah = (fn) => (req, res, next) => {
  try {
    Promise.resolve(fn(req, res, next)).catch(next);
  } catch (e) {
    next(e);
  }
};

export const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

const str = (v) => (v === undefined || v === null ? null : String(v).trim() || null);

// Bahasa Indonesia and common spreadsheet spellings accepted on import
const SYNONYMS = {
  kritis: 'critical', tinggi: 'high', sedang: 'medium', menengah: 'medium', rendah: 'low',
  p1: 'critical', p2: 'high', p3: 'medium', p4: 'low', major: 'high', minor: 'low',
  otomatis: 'automated', automation: 'automated', siap: 'ready', usang: 'obsolete',
  negatif: 'negative', positive: 'functional', positif: 'functional', fungsional: 'functional',
};

const pick = (value, allowed, fallback) => {
  if (!value) return fallback;
  const v = String(value).trim().toLowerCase();
  const hit = allowed.find((a) => a.toLowerCase() === (SYNONYMS[v] || v));
  return hit || fallback;
};

export function mustGet(sql, id, what) {
  const row = get(sql, id);
  if (!row) throw new HttpError(404, `${what} not found`);
  return row;
}

export const getProject = (id) => mustGet('SELECT * FROM projects WHERE id = ?', id, 'Project');
export const getSuite = (id) => mustGet('SELECT * FROM suites WHERE id = ?', id, 'Test suite');
export const getPlan = (id) => mustGet('SELECT * FROM test_plans WHERE id = ?', id, 'Test plan');

/* ---------------------------------------------------------------- suites */

export function subtreeSuiteIds(suiteId) {
  return all(
    `WITH RECURSIVE t(id) AS (
       SELECT ? UNION ALL SELECT s.id FROM suites s JOIN t ON s.parent_id = t.id
     ) SELECT id FROM t`, suiteId
  ).map((r) => r.id);
}

/** Map of suite id -> "Parent / Child / Grandchild". */
export function suitePaths(projectId) {
  const suites = all('SELECT id, parent_id, name FROM suites WHERE project_id = ?', projectId);
  const byId = new Map(suites.map((s) => [s.id, s]));
  const cache = new Map();
  const pathOf = (id) => {
    if (cache.has(id)) return cache.get(id);
    const s = byId.get(id);
    if (!s) return '';
    const p = s.parent_id ? `${pathOf(s.parent_id)} / ${s.name}` : s.name;
    cache.set(id, p);
    return p;
  };
  suites.forEach((s) => pathOf(s.id));
  return cache;
}

/** Finds or creates a suite chain from a path like "Payments / Transfer". */
export function ensureSuitePath(projectId, suitePath, rootParentId = null) {
  const parts = String(suitePath || '').split(/\s*[/>\\]\s*/).map((p) => p.trim()).filter(Boolean);
  let parent = rootParentId;
  for (const name of parts) {
    const existing = get(
      'SELECT id FROM suites WHERE project_id = ? AND parent_id IS ? AND name = ? COLLATE NOCASE',
      projectId, parent, name
    );
    parent = existing ? existing.id : createSuite(projectId, parent, name, null);
  }
  return parent;
}

export function createSuite(projectId, parentId, name, description) {
  if (!str(name)) throw new HttpError(400, 'Suite name is required');
  if (parentId) {
    const parent = getSuite(parentId);
    if (parent.project_id !== projectId) throw new HttpError(400, 'Parent suite belongs to another project');
  }
  const sort = get('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM suites WHERE project_id = ? AND parent_id IS ?', projectId, parentId).n;
  return Number(run('INSERT INTO suites (project_id, parent_id, name, description, sort) VALUES (?, ?, ?, ?, ?)',
    projectId, parentId || null, str(name), str(description), sort).lastInsertRowid);
}

function uniqueSiblingName(projectId, parentId, name) {
  let candidate = name;
  for (let i = 1; get('SELECT 1 FROM suites WHERE project_id = ? AND parent_id IS ? AND name = ?', projectId, parentId, candidate); i++) {
    candidate = `${name} (copy${i > 1 ? ' ' + i : ''})`;
  }
  return candidate;
}

export function moveSuite(suiteId, newParentId) {
  const suite = getSuite(suiteId);
  if (newParentId) {
    const target = getSuite(newParentId);
    if (target.project_id !== suite.project_id) throw new HttpError(400, 'Cannot move a suite to another project');
    if (subtreeSuiteIds(suiteId).includes(newParentId)) throw new HttpError(400, 'Cannot move a suite into itself or its children');
  }
  const sort = get('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM suites WHERE project_id = ? AND parent_id IS ?', suite.project_id, newParentId || null).n;
  run('UPDATE suites SET parent_id = ?, sort = ? WHERE id = ?', newParentId || null, sort, suiteId);
}

export function copySuite(suiteId, newParentId, userId) {
  return tx(() => {
    const suite = getSuite(suiteId);
    if (newParentId) {
      const target = getSuite(newParentId);
      if (target.project_id !== suite.project_id) throw new HttpError(400, 'Cannot copy a suite to another project');
      if (subtreeSuiteIds(suiteId).includes(newParentId)) throw new HttpError(400, 'Cannot copy a suite into itself or its children');
    }
    const copyTree = (srcId, parentId, rename) => {
      const src = getSuite(srcId);
      const name = rename ? uniqueSiblingName(src.project_id, parentId, src.name) : src.name;
      const newId = createSuite(src.project_id, parentId, name, src.description);
      for (const c of all('SELECT id FROM test_cases WHERE suite_id = ? ORDER BY sort, id', srcId)) copyCase(c.id, newId, userId);
      for (const child of all('SELECT id FROM suites WHERE parent_id = ? ORDER BY sort, id', srcId)) copyTree(child.id, newId, false);
      return newId;
    };
    return copyTree(suiteId, newParentId || null, true);
  });
}

/** Refuses to delete cases that already carry execution evidence. */
export function assertNotExecuted(caseIds, what) {
  if (!caseIds.length) return;
  const row = get(
    `SELECT COUNT(*) AS n FROM executions e JOIN plan_cases pc ON pc.id = e.plan_case_id
     WHERE pc.case_id IN (${caseIds.map(() => '?').join(',')})`, ...caseIds
  );
  if (row.n > 0) {
    throw new HttpError(409, `${what} has execution history (${row.n} run(s)). Mark the cases as Obsolete instead, or delete the test plans that executed them first.`);
  }
}

export function deleteSuite(suiteId) {
  const ids = subtreeSuiteIds(suiteId);
  const caseIds = all(`SELECT id FROM test_cases WHERE suite_id IN (${ids.map(() => '?').join(',')})`, ...ids).map((r) => r.id);
  assertNotExecuted(caseIds, 'This suite');
  run('DELETE FROM suites WHERE id = ?', suiteId);
}

/* ---------------------------------------------------------------- cases */

export function nextCaseKey(projectId) {
  const project = getProject(projectId);
  let seq = project.case_seq;
  let key;
  do {
    seq++;
    key = `${project.prefix}-${seq}`;
  } while (get('SELECT 1 FROM test_cases WHERE project_id = ? AND case_key = ?', projectId, key));
  run('UPDATE projects SET case_seq = ? WHERE id = ?', seq, projectId);
  return key;
}

export function normalizeCase(body) {
  const title = str(body.title);
  if (!title) throw new HttpError(400, 'Test case title is required');
  const est = toInt(body.estimated_minutes);
  return {
    title,
    objective: str(body.objective),
    preconditions: str(body.preconditions),
    postconditions: str(body.postconditions),
    priority: pick(body.priority, PRIORITIES, 'Medium'),
    test_type: pick(body.test_type, TEST_TYPES, 'Functional'),
    execution_type: pick(body.execution_type, EXECUTION_TYPES, 'Manual'),
    status: pick(body.status, CASE_STATUSES, 'Ready'),
    requirement_ref: str(body.requirement_ref),
    tags: str(body.tags),
    estimated_minutes: est && est > 0 ? est : null,
    // left undefined when the caller does not mention it, so older clients never wipe the link to test code
    ...('automation_ref' in body ? { automation_ref: str(body.automation_ref)?.slice(0, 500) ?? null } : {}),
  };
}

export function normalizeSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map((s) => ({ action: str(s.action), test_data: str(s.test_data), expected_result: str(s.expected_result) }))
    .filter((s) => s.action || s.expected_result)
    .map((s, i) => ({ ...s, action: s.action || '-', step_no: i + 1 }));
}

function writeSteps(caseId, steps) {
  run('DELETE FROM test_steps WHERE case_id = ?', caseId);
  for (const s of steps) {
    run('INSERT INTO test_steps (case_id, step_no, action, test_data, expected_result) VALUES (?, ?, ?, ?, ?)',
      caseId, s.step_no, s.action, s.test_data, s.expected_result);
  }
}

const CASE_COLS = ['title', 'objective', 'preconditions', 'postconditions', 'priority', 'test_type',
  'execution_type', 'status', 'requirement_ref', 'tags', 'estimated_minutes', 'automation_ref'];

const isUniqueViolation = (e) => /UNIQUE constraint failed/i.test(e?.message || '');

export function createCase(suiteId, data, steps, userId, caseKey = null) {
  return tx(() => {
    const suite = getSuite(suiteId);
    const key = caseKey && !get('SELECT 1 FROM test_cases WHERE project_id = ? AND case_key = ?', suite.project_id, caseKey)
      ? caseKey : nextCaseKey(suite.project_id);
    const sort = get('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM test_cases WHERE suite_id = ?', suiteId).n;
    let id;
    try {
      id = Number(run(
        `INSERT INTO test_cases (project_id, suite_id, case_key, ${CASE_COLS.join(', ')}, sort, created_by, updated_by)
         VALUES (?, ?, ?, ${CASE_COLS.map(() => '?').join(', ')}, ?, ?, ?)`,
        suite.project_id, suiteId, key, ...CASE_COLS.map((c) => data[c]), sort, userId, userId
      ).lastInsertRowid);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, `Automation reference "${data.automation_ref}" is already used by another test case in this project`);
      throw e;
    }
    writeSteps(id, steps);
    return id;
  });
}

export function updateCase(caseId, data, steps, userId) {
  return tx(() => {
    const current = getCase(caseId);
    if (data.automation_ref === undefined) data = { ...data, automation_ref: current.automation_ref };
    const stepSig = (list) => JSON.stringify(list.map((s) => [s.action, s.test_data || null, s.expected_result || null]));
    const changed = CASE_COLS.some((c) => (current[c] ?? null) !== (data[c] ?? null)) || stepSig(current.steps) !== stepSig(steps);
    if (!changed) return false;
    try {
      run(
        `UPDATE test_cases SET ${CASE_COLS.map((c) => `${c} = ?`).join(', ')}, version = version + 1,
         updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        ...CASE_COLS.map((c) => data[c]), userId, caseId
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, `Automation reference "${data.automation_ref}" is already used by another test case in this project`);
      throw e;
    }
    writeSteps(caseId, steps);
    return true;
  });
}

export function getCase(caseId) {
  const c = get(
    `SELECT c.*, cu.full_name AS created_by_name, uu.full_name AS updated_by_name
     FROM test_cases c LEFT JOIN users cu ON cu.id = c.created_by LEFT JOIN users uu ON uu.id = c.updated_by
     WHERE c.id = ?`, caseId
  );
  if (!c) throw new HttpError(404, 'Test case not found');
  c.steps = all('SELECT id, step_no, action, test_data, expected_result FROM test_steps WHERE case_id = ? ORDER BY step_no', caseId);
  return c;
}

export function copyCase(caseId, targetSuiteId, userId) {
  const c = getCase(caseId);
  const target = getSuite(targetSuiteId);
  if (target.project_id !== c.project_id) throw new HttpError(400, 'Cannot copy a test case to another project');
  // a copy is not the automated test itself, so it must not claim the same automation reference
  return createCase(targetSuiteId, { ...c, automation_ref: null }, c.steps, userId);
}

export function moveCase(caseId, targetSuiteId) {
  const c = getCase(caseId);
  const target = getSuite(targetSuiteId);
  if (target.project_id !== c.project_id) throw new HttpError(400, 'Cannot move a test case to another project');
  const sort = get('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM test_cases WHERE suite_id = ?', targetSuiteId).n;
  run('UPDATE test_cases SET suite_id = ?, sort = ? WHERE id = ?', targetSuiteId, sort, caseId);
}

/* ---------------------------------------------------------------- plans */

const naturalCmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

/** Every case in a plan with its latest execution, ordered by suite path then case key. */
export function planCases(planId) {
  const plan = getPlan(planId);
  const paths = suitePaths(plan.project_id);
  const rows = all(
    `SELECT pc.id AS plan_case_id, pc.assigned_to, au.full_name AS assigned_name,
            c.id AS case_id, c.case_key, c.title, c.priority, c.suite_id, c.version AS case_version, c.status AS case_status,
            e.id AS execution_id, COALESCE(e.status, 'Not Run') AS status, e.executed_at, e.case_version AS executed_version,
            eu.full_name AS executed_by_name, e.approval_status, e.defect_ref, e.actual_result,
            (SELECT COUNT(*) FROM executions x WHERE x.plan_case_id = pc.id) AS run_count
     FROM plan_cases pc
     JOIN test_cases c ON c.id = pc.case_id
     LEFT JOIN users au ON au.id = pc.assigned_to
     LEFT JOIN executions e ON e.id = (SELECT MAX(id) FROM executions WHERE plan_case_id = pc.id)
     LEFT JOIN users eu ON eu.id = e.executed_by
     WHERE pc.plan_id = ?`, planId
  );
  for (const r of rows) r.suite_path = paths.get(r.suite_id) || '';
  rows.sort((a, b) => naturalCmp(a.suite_path, b.suite_path) || naturalCmp(a.case_key, b.case_key));
  return rows;
}

export function summarize(rows) {
  const s = { total: rows.length, Passed: 0, Failed: 0, Blocked: 0, Skipped: 0, 'Not Run': 0, Approved: 0, Rejected: 0, PendingApproval: 0 };
  for (const r of rows) {
    s[r.status] = (s[r.status] || 0) + 1;
    if (r.execution_id) {
      if (r.approval_status === 'Approved') s.Approved++;
      else if (r.approval_status === 'Rejected') s.Rejected++;
      else s.PendingApproval++;
    }
  }
  s.executed = s.total - s['Not Run'];
  s.progress = s.total ? Math.round((s.executed / s.total) * 1000) / 10 : 0;
  s.pass_rate = s.executed ? Math.round((s.Passed / s.executed) * 1000) / 10 : 0;
  return s;
}

export function addCasesToPlan(planId, caseIds) {
  const plan = getPlan(planId);
  let added = 0;
  tx(() => {
    for (const id of caseIds) {
      const c = get('SELECT id, project_id, status FROM test_cases WHERE id = ?', id);
      if (!c || c.project_id !== plan.project_id || c.status === 'Obsolete') continue;
      added += Number(run('INSERT OR IGNORE INTO plan_cases (plan_id, case_id) VALUES (?, ?)', planId, id).changes);
    }
  });
  return added;
}

export function casesInSuites(suiteIds) {
  const ids = [...new Set(suiteIds.flatMap((id) => subtreeSuiteIds(id)))];
  if (!ids.length) return [];
  return all(`SELECT id FROM test_cases WHERE suite_id IN (${ids.map(() => '?').join(',')}) AND status != 'Obsolete'`, ...ids).map((r) => r.id);
}

export function executionDetails(planCaseId) {
  const execs = all(
    `SELECT e.*, eu.full_name AS executed_by_name, apu.full_name AS approved_by_name
     FROM executions e LEFT JOIN users eu ON eu.id = e.executed_by LEFT JOIN users apu ON apu.id = e.approved_by
     WHERE e.plan_case_id = ? ORDER BY e.id DESC`, planCaseId
  );
  for (const e of execs) {
    e.steps = all('SELECT step_no, action, expected_result, status, actual_result FROM execution_steps WHERE execution_id = ? ORDER BY step_no', e.id);
    e.attachments = all('SELECT id, original_name, mime_type, size, created_at FROM attachments WHERE execution_id = ? ORDER BY id', e.id);
  }
  return execs;
}

export function removeAttachmentFile(storedName) {
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(storedName)));
  } catch {
    /* already gone */
  }
}

/** Collects evidence file names before a cascade delete so files can be cleaned up afterwards. */
export function attachmentFilesFor(whereSql, ...params) {
  return all(
    `SELECT a.stored_name FROM attachments a JOIN executions e ON e.id = a.execution_id
     JOIN plan_cases pc ON pc.id = e.plan_case_id WHERE ${whereSql}`, ...params
  ).map((r) => r.stored_name);
}
