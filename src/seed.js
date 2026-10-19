// Loads a demo project so the tool can be explored right away: `npm run seed`.
import { all, get, run, hashPassword } from './db.js';
import { createSuite, createCase, normalizeCase, normalizeSteps, addCasesToPlan, planCases } from './services.js';

if (get("SELECT 1 FROM projects WHERE prefix = 'DEMO'")) {
  console.log('Demo project already exists. Nothing to do.');
  process.exit(0);
}

const user = (username, full_name, role, company, title) =>
  get('SELECT id FROM users WHERE username = ?', username)?.id ??
  Number(run('INSERT INTO users (username, full_name, role, company, title, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
    username, full_name, role, company, title, hashPassword('demo123')).lastInsertRowid);

const admin = get("SELECT id FROM users WHERE username = 'admin'").id;
const tester = user('tester', 'Rina Pratama', 'tester', 'PT Solusi Vendor', 'QA Engineer');
user('client', 'Budi Santoso', 'client', 'PT Bank Contoh', 'Head of Digital Banking');

const projectId = Number(run(
  'INSERT INTO projects (name, prefix, description, client_name, vendor_name) VALUES (?, ?, ?, ?, ?)',
  'Mobile Banking Demo', 'DEMO', 'Demo project for the mobile banking release 2.4', 'PT Bank Contoh', 'PT Solusi Vendor'
).lastInsertRowid);

const auth = createSuite(projectId, null, 'Authentication', 'Login, logout and session handling');
const payments = createSuite(projectId, null, 'Payments', null);
const transfer = createSuite(projectId, payments, 'Transfer', null);
const billpay = createSuite(projectId, payments, 'Bill Payment', null);

const add = (suite, fields, steps) => createCase(suite, normalizeCase(fields), normalizeSteps(steps), admin);

add(auth, { title: 'Login with valid credentials', objective: 'Registered user can log in', preconditions: 'Active user account', priority: 'High', requirement_ref: 'BRD-AUTH-01', tags: 'smoke' }, [
  { action: 'Open the mobile app', expected_result: 'Login screen is displayed' },
  { action: 'Enter username and password, tap Login', test_data: 'user01 / Passw0rd!', expected_result: 'Home screen with account balance is displayed' },
]);
add(auth, { title: 'Login with wrong password is rejected', priority: 'High', test_type: 'Negative', requirement_ref: 'BRD-AUTH-01' }, [
  { action: 'Enter valid username and wrong password, tap Login', test_data: 'user01 / wrong', expected_result: 'Message "Username atau password salah" is shown' },
]);
add(auth, { title: 'Account locked after 3 failed attempts', priority: 'Critical', test_type: 'Security', requirement_ref: 'BRD-AUTH-02' }, [
  { action: 'Enter wrong password 3 times', expected_result: 'Account is locked and user is told to contact the call center' },
]);
add(transfer, { title: 'Transfer between own accounts', priority: 'Critical', preconditions: 'Balance >= Rp100.000', requirement_ref: 'FSD-TRF-01', tags: 'regression' }, [
  { action: 'Open Transfer > Own Account', expected_result: 'Transfer form is displayed' },
  { action: 'Choose destination, enter amount, tap Next', test_data: 'Rp50.000', expected_result: 'Confirmation screen is displayed' },
  { action: 'Enter OTP and confirm', test_data: 'OTP 123456', expected_result: 'Transfer succeeds; receipt is displayed' },
]);
add(transfer, { title: 'Interbank transfer via BI-FAST', priority: 'High', requirement_ref: 'FSD-TRF-03' }, [
  { action: 'Open Transfer > Other Bank, choose BI-FAST', expected_result: 'Form is displayed with fee Rp2.500' },
  { action: 'Fill destination account and amount, confirm with OTP', test_data: 'BCA 1234567890 / Rp100.000', expected_result: 'Transfer succeeds; receipt shows reference number' },
]);
add(billpay, { title: 'Pay electricity bill (PLN postpaid)', priority: 'Medium', requirement_ref: 'FSD-BILL-02' }, [
  { action: 'Open Payment > PLN, enter customer ID', test_data: '512345678901', expected_result: 'Bill amount and customer name are displayed' },
  { action: 'Confirm with PIN', expected_result: 'Payment succeeds; receipt is displayed' },
]);

const planId = Number(run(
  `INSERT INTO test_plans (project_id, name, description, environment, build_version, start_date, end_date, created_by)
   VALUES (?, ?, ?, 'SIT', ?, ?, ?, ?)`,
  projectId, 'SIT Release 2.4', 'System integration test for release 2.4', 'v2.4.0-rc1', '2026-10-12', '2026-10-23', admin
).lastInsertRowid);
addCasesToPlan(planId, get('SELECT group_concat(id) AS ids FROM test_cases WHERE project_id = ?', projectId).ids.split(',').map(Number));

const results = ['Passed', 'Passed', 'Failed', 'Passed'];
planCases(planId).slice(0, results.length).forEach((pc, i) => {
  const execId = Number(run(
    `INSERT INTO executions (plan_case_id, case_version, status, actual_result, defect_ref, executed_by)
     VALUES (?, 1, ?, ?, ?, ?)`,
    pc.plan_case_id, results[i], results[i] === 'Failed' ? 'Account is not locked after 3 attempts; 4th attempt still allowed' : 'As expected',
    results[i] === 'Failed' ? 'JIRA-1042' : null, tester
  ).lastInsertRowid);
  for (const s of all('SELECT step_no, action, expected_result FROM test_steps WHERE case_id = ? ORDER BY step_no', pc.case_id)) {
    run('INSERT INTO execution_steps (execution_id, step_no, action, expected_result, status) VALUES (?, ?, ?, ?, ?)',
      execId, s.step_no, s.action, s.expected_result, results[i]);
  }
});

console.log('Demo project "Mobile Banking Demo" (DEMO) created.');
console.log('Demo users: tester / demo123 (QA), client / demo123 (UAT approver).');
