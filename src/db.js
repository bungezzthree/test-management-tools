import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'testmgmt.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'tester',          -- admin | tester | client
  company TEXT,
  title TEXT,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  client_name TEXT,
  vendor_name TEXT,
  case_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS suites (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES suites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS test_cases (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id INTEGER NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  case_key TEXT NOT NULL,                        -- e.g. CBS-12 (unique per project)
  title TEXT NOT NULL,
  objective TEXT,
  preconditions TEXT,
  postconditions TEXT,
  priority TEXT NOT NULL DEFAULT 'Medium',       -- Critical | High | Medium | Low
  test_type TEXT NOT NULL DEFAULT 'Functional',  -- Functional | Negative | Regression | Integration | Performance | Security | Usability
  execution_type TEXT NOT NULL DEFAULT 'Manual', -- Manual | Automated
  status TEXT NOT NULL DEFAULT 'Ready',          -- Draft | Ready | Obsolete
  requirement_ref TEXT,
  tags TEXT,
  estimated_minutes INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS test_steps (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  step_no INTEGER NOT NULL,
  action TEXT NOT NULL,
  test_data TEXT,
  expected_result TEXT
);

CREATE TABLE IF NOT EXISTS test_plans (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  environment TEXT NOT NULL DEFAULT 'SIT',       -- SIT | UAT
  build_version TEXT,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'Active',         -- Active | Closed
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plan_cases (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (plan_id, case_id)
);

CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY,
  plan_case_id INTEGER NOT NULL REFERENCES plan_cases(id) ON DELETE CASCADE,
  case_version INTEGER,
  status TEXT NOT NULL,                          -- Passed | Failed | Blocked | Skipped
  actual_result TEXT,
  notes TEXT,
  defect_ref TEXT,
  duration_minutes INTEGER,
  executed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approval_status TEXT NOT NULL DEFAULT 'Pending', -- Pending | Approved | Rejected
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  approval_note TEXT
);

CREATE TABLE IF NOT EXISTS execution_steps (
  id INTEGER PRIMARY KEY,
  execution_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  step_no INTEGER NOT NULL,
  action TEXT,
  expected_result TEXT,
  status TEXT,
  actual_result TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  execution_id INTEGER NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS signoffs (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES test_plans(id) ON DELETE CASCADE,
  party TEXT NOT NULL,                           -- vendor | client
  signer_name TEXT NOT NULL,
  signer_title TEXT,
  company TEXT,
  decision TEXT NOT NULL,                        -- Approved | Approved with notes | Rejected
  note TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  signed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_key ON test_cases(project_id, case_key);
CREATE INDEX IF NOT EXISTS idx_suites_project ON suites(project_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_cases_suite ON test_cases(suite_id);
CREATE INDEX IF NOT EXISTS idx_steps_case ON test_steps(case_id, step_no);
CREATE INDEX IF NOT EXISTS idx_plan_cases_plan ON plan_cases(plan_id);
CREATE INDEX IF NOT EXISTS idx_exec_pc ON executions(plan_case_id);
CREATE INDEX IF NOT EXISTS idx_att_exec ON attachments(execution_id);
`);

// node:sqlite cannot bind undefined or booleans
const norm = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

export const all = (sql, ...p) => db.prepare(sql).all(...norm(p));
export const get = (sql, ...p) => db.prepare(sql).get(...norm(p));
export const run = (sql, ...p) => db.prepare(sql).run(...norm(p));

let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) return fn();
  txDepth++;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(password, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// First run: create an administrator so the app can be used immediately.
if (!get('SELECT id FROM users LIMIT 1')) {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  run(
    'INSERT INTO users (username, full_name, role, password_hash) VALUES (?, ?, ?, ?)',
    'admin', 'Administrator', 'admin', hashPassword(pw)
  );
  console.log(`Created default user "admin" (password from ADMIN_PASSWORD or the default in README). Change it after first login.`);
}

/** Error carrying an HTTP status, rendered as JSON by the error handler. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
