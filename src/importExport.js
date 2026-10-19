import ExcelJS from 'exceljs';
import { all, get, tx } from './db.js';
import {
  normalizeCase, normalizeSteps, createCase, updateCase, moveCase, ensureSuitePath, suitePaths,
  subtreeSuiteIds, getSuite,
} from './services.js';

/** Column layout shared by import, export and the template (one row per test step). */
export const COLUMNS = [
  { key: 'suite', header: 'Test Suite', width: 28 },
  { key: 'case_key', header: 'Test Case ID', width: 14 },
  { key: 'title', header: 'Test Case Title', width: 36 },
  { key: 'objective', header: 'Objective / Description', width: 36 },
  { key: 'preconditions', header: 'Preconditions', width: 30 },
  { key: 'postconditions', header: 'Postconditions', width: 22 },
  { key: 'priority', header: 'Priority', width: 10 },
  { key: 'test_type', header: 'Test Type', width: 13 },
  { key: 'execution_type', header: 'Execution Type', width: 13 },
  { key: 'status', header: 'Status', width: 10 },
  { key: 'requirement_ref', header: 'Requirement ID', width: 15 },
  { key: 'tags', header: 'Tags', width: 15 },
  { key: 'estimated_minutes', header: 'Est. Minutes', width: 11 },
  { key: 'step_no', header: 'Step No', width: 8 },
  { key: 'action', header: 'Test Step', width: 40 },
  { key: 'test_data', header: 'Test Data', width: 24 },
  { key: 'expected_result', header: 'Expected Result', width: 40 },
];

// Header spellings commonly found in existing Excel test scripts (English and Bahasa Indonesia).
const ALIASES = {
  suite: ['testsuite', 'suite', 'suitepath', 'folder', 'module', 'modul', 'feature', 'fitur', 'menu'],
  case_key: ['testcaseid', 'tcid', 'caseid', 'id', 'testid', 'scenarioid', 'idskenario', 'idtestcase', 'no.testcase'],
  title: ['testcasetitle', 'testcasename', 'title', 'name', 'testcase', 'scenario', 'testscenario', 'skenario', 'judul', 'namatestcase'],
  objective: ['objectivedescription', 'objective', 'description', 'summary', 'deskripsi', 'tujuan'],
  preconditions: ['preconditions', 'precondition', 'prerequisite', 'prasyarat', 'kondisiawal'],
  postconditions: ['postconditions', 'postcondition'],
  priority: ['priority', 'prioritas', 'importance', 'severity'],
  test_type: ['testtype', 'type', 'tipe', 'jenis'],
  execution_type: ['executiontype', 'execution', 'manualautomated'],
  status: ['status', 'casestatus'],
  requirement_ref: ['requirementid', 'requirement', 'reqid', 'requirementref', 'brd', 'fsd', 'userstory'],
  tags: ['tags', 'tag', 'labels', 'keywords'],
  estimated_minutes: ['estminutes', 'estimatedminutes', 'estimate', 'duration', 'durasi'],
  step_no: ['stepno', 'step', 'stepnumber', 'no.step', 'langkahke'],
  action: ['teststep', 'teststeps', 'steps', 'stepaction', 'action', 'langkah', 'langkahpengujian', 'stepdescription'],
  test_data: ['testdata', 'data', 'datauji'],
  expected_result: ['expectedresult', 'expectedresults', 'expected', 'expectedoutput', 'hasilyangdiharapkan', 'hasildiharapkan'],
};

const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9.]/g, '').replace(/\.$/, '');

function mapHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const n = normHeader(h);
    for (const [key, names] of Object.entries(ALIASES)) {
      if (map[key] === undefined && names.includes(n)) {
        map[key] = i;
        break;
      }
    }
  });
  return map;
}

/** RFC 4180 CSV parser with delimiter auto-detection (comma, semicolon or tab). */
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets.find((w) => w.rowCount > 0);
  if (!ws) return [];
  const rows = [];
  const width = ws.columnCount;
  ws.eachRow({ includeEmpty: true }, (r) => {
    const cells = [];
    for (let c = 1; c <= width; c++) cells.push(r.getCell(c).text ?? '');
    rows.push(cells);
  });
  return rows;
}

// "1. Open app\n2. Login" -> ["Open app", "Login"]
function splitNumbered(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  if (lines.filter((l) => /^\s*\d+\s*[.)-]\s+/.test(l)).length < 2) return [String(text).trim()];
  const out = [];
  for (const line of lines) {
    if (/^\s*\d+\s*[.)-]\s+/.test(line)) out.push(line.replace(/^\s*\d+\s*[.)-]\s+/, '').trim());
    else if (out.length && line.trim()) out[out.length - 1] += '\n' + line.trim();
    else if (line.trim()) out.push(line.trim());
  }
  return out;
}

/**
 * Imports test cases from CSV/XLSX. A row starts a new test case when its Test Case ID or
 * Title differs from the previous row; otherwise it adds a step to the current case.
 * Existing IDs in the project are updated, new IDs are kept, missing IDs are generated.
 */
export async function importCases({ projectId, buffer, filename, defaultSuiteId, userId }) {
  const isCsv = /\.(csv|txt)$/i.test(filename || '');
  const rows = isCsv ? parseCsv(buffer.toString('utf8')) : await readXlsx(buffer);
  const headerIdx = rows.findIndex((r) => r.some((c) => String(c).trim()));
  if (headerIdx < 0) return { created: 0, updated: 0, unchanged: 0, errors: [{ row: 0, message: 'The file is empty' }] };
  const map = mapHeaders(rows[headerIdx]);
  if (map.title === undefined && map.case_key === undefined) {
    return { created: 0, updated: 0, unchanged: 0, errors: [{ row: headerIdx + 1, message: 'No "Test Case Title" or "Test Case ID" column found. Download the template to see the expected columns.' }] };
  }
  const val = (r, k) => (map[k] === undefined ? '' : String(r[map[k]] ?? '').trim());

  const cases = [];
  let cur = null;
  rows.slice(headerIdx + 1).forEach((r, i) => {
    const rowNo = headerIdx + i + 2;
    if (!r.some((c) => String(c).trim())) return;
    const key = val(r, 'case_key');
    const title = val(r, 'title');
    const identity = key || title;
    if (identity && (!cur || identity !== (cur.fields.case_key || cur.fields.title))) {
      const fields = {};
      for (const c of COLUMNS) fields[c.key] = val(r, c.key);
      cur = { rowNo, fields, steps: [] };
      cases.push(cur);
    } else if (!cur) {
      return;
    }
    const actions = splitNumbered(val(r, 'action'));
    const expected = splitNumbered(val(r, 'expected_result'));
    const data = val(r, 'test_data');
    const n = Math.max(actions.length, expected.length);
    for (let s = 0; s < n; s++) {
      cur.steps.push({ action: actions[s] || '', test_data: s === 0 ? data : '', expected_result: expected[s] || '' });
    }
  });

  const result = { created: 0, updated: 0, unchanged: 0, errors: [] };
  let fallbackSuite = defaultSuiteId || null;
  tx(() => {
    for (const c of cases) {
      try {
        if (!c.fields.title) {
          const existing = c.fields.case_key && get('SELECT title FROM test_cases WHERE project_id = ? AND case_key = ?', projectId, c.fields.case_key);
          if (!existing) throw new Error('Test Case Title is empty');
          c.fields.title = existing.title;
        }
        const data = normalizeCase(c.fields);
        const steps = normalizeSteps(c.steps);
        let suiteId;
        if (c.fields.suite) suiteId = ensureSuitePath(projectId, c.fields.suite, defaultSuiteId || null);
        else suiteId = fallbackSuite ||= ensureSuitePath(projectId, 'Imported');
        const existing = c.fields.case_key && get('SELECT id, suite_id FROM test_cases WHERE project_id = ? AND case_key = ?', projectId, c.fields.case_key);
        if (existing) {
          if (updateCase(existing.id, data, steps, userId)) result.updated++;
          else result.unchanged++;
          if (c.fields.suite && existing.suite_id !== suiteId) moveCase(existing.id, suiteId);
        } else {
          createCase(suiteId, data, steps, userId, c.fields.case_key || null);
          result.created++;
        }
      } catch (e) {
        result.errors.push({ row: c.rowNo, message: e.message });
      }
    }
  });
  return result;
}

function exportRows(projectId, suiteId) {
  const paths = suitePaths(projectId);
  const suiteIds = suiteId ? subtreeSuiteIds(suiteId) : null;
  const cases = all(
    `SELECT * FROM test_cases WHERE project_id = ? ${suiteIds ? `AND suite_id IN (${suiteIds.map(() => '?').join(',')})` : ''}`,
    projectId, ...(suiteIds || [])
  );
  const collator = new Intl.Collator(undefined, { numeric: true });
  cases.sort((a, b) => collator.compare(paths.get(a.suite_id), paths.get(b.suite_id)) || a.sort - b.sort || a.id - b.id);
  const out = [];
  for (const c of cases) {
    const steps = all('SELECT * FROM test_steps WHERE case_id = ? ORDER BY step_no', c.id);
    const base = { ...c, suite: paths.get(c.suite_id) };
    if (!steps.length) out.push(base);
    steps.forEach((s, i) => {
      const stepCols = { step_no: s.step_no, action: s.action, test_data: s.test_data, expected_result: s.expected_result };
      out.push(i === 0 ? { ...base, ...stepCols } : { case_key: c.case_key, ...stepCols });
    });
  }
  return out;
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows) {
  const lines = [COLUMNS.map((c) => csvCell(c.header)).join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => csvCell(r[c.key])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export async function toXlsx(rows, sheetName = 'Test Cases') {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Test Management Tools';
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  rows.forEach((r) => ws.addRow(Object.fromEntries(COLUMNS.map((c) => [c.key, r[c.key] ?? null]))));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  ws.eachRow((row) => { row.alignment = { vertical: 'top', wrapText: true }; });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const exportCases = (projectId, suiteId) => exportRows(projectId, suiteId);

export const TEMPLATE_ROWS = [
  { suite: 'Login', case_key: '', title: 'Login with valid credentials', objective: 'Verify a registered user can log in', preconditions: 'User account is active', priority: 'High', test_type: 'Functional', execution_type: 'Manual', status: 'Ready', requirement_ref: 'BRD-001', tags: 'smoke', estimated_minutes: 5, step_no: 1, action: 'Open the login page', test_data: '', expected_result: 'Login page is displayed' },
  { step_no: 2, action: 'Enter username and password, click Login', test_data: 'user01 / Passw0rd!', expected_result: 'Dashboard is displayed' },
  { suite: 'Login', case_key: '', title: 'Login with wrong password', objective: 'Verify login is rejected with a wrong password', preconditions: 'User account is active', priority: 'Medium', test_type: 'Negative', execution_type: 'Manual', status: 'Ready', requirement_ref: 'BRD-001', tags: '', estimated_minutes: 3, step_no: 1, action: 'Enter a valid username and a wrong password, click Login', test_data: 'user01 / wrong', expected_result: 'Error "Invalid username or password" is shown' },
  { suite: 'Payments / Transfer', case_key: '', title: 'Transfer between own accounts', objective: '', preconditions: 'User is logged in; balance >= 100,000', priority: 'Critical', test_type: 'Functional', execution_type: 'Manual', status: 'Ready', requirement_ref: 'FSD-TRF-01', tags: 'regression', estimated_minutes: 10, step_no: 1, action: 'Open Transfer menu', test_data: '', expected_result: 'Transfer form is displayed' },
  { step_no: 2, action: 'Fill destination and amount, submit', test_data: 'Amount 50,000', expected_result: 'Confirmation page is displayed' },
  { step_no: 3, action: 'Confirm with OTP', test_data: 'OTP 123456', expected_result: 'Transfer succeeds and balance is reduced by 50,000' },
];

export function suiteBelongs(projectId, suiteId) {
  return !suiteId || getSuite(suiteId).project_id === projectId;
}
