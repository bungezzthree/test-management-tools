// Integration tests for the automation API: node --test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server;
let base;
let dataDir;
let cookie;
let token;
let projectId;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function call(method, url, { body, headers = {}, auth = 'token', form } = {}) {
  const h = { ...headers };
  if (auth === 'token') h.Authorization = `Bearer ${token}`;
  if (auth === 'cookie') h.Cookie = cookie;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${base}/api${url}`, { method, headers: h, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testdesk-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: root, env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', ADMIN_PASSWORD: 'admin-pass-1' }, stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(base); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-pass-1' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const p = await call('POST', '/projects', { auth: 'cookie', body: { name: 'Bank Core', prefix: 'CBS', client_name: 'PT Bank', vendor_name: 'PT Vendor' } });
  projectId = p.data.id;
  const t = await call('POST', '/tokens', { auth: 'cookie', body: { name: 'CI' } });
  assert.equal(t.status, 201);
  assert.match(t.data.token, /^tdk_/);
  token = t.data.token;
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited; // Windows keeps the SQLite files locked until the process is gone
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('token works for automation and identity, but nothing else', async () => {
  assert.equal((await call('GET', '/auth/me')).status, 200);
  assert.equal((await call('GET', '/projects')).status, 200);
  assert.equal((await call('DELETE', `/projects/${projectId}`)).status, 403);
  assert.equal((await call('GET', '/users')).status, 403);
  assert.equal((await call('POST', '/tokens', { body: { name: 'x' } })).status, 403);
  assert.equal((await call('GET', '/auth/me', { auth: 'none', headers: { Authorization: 'Bearer tdk_wrong' } })).status, 401);
});

test('token list never exposes the secret and can be revoked', async () => {
  const t = await call('POST', '/tokens', { auth: 'cookie', body: { name: 'temp', expires_days: 1 } });
  const list = await call('GET', '/tokens', { auth: 'cookie' });
  assert.ok(list.data.some((x) => x.id === t.data.id && x.prefix === t.data.prefix));
  assert.ok(!JSON.stringify(list.data).includes(t.data.token));
  assert.equal((await call('GET', '/auth/me', { auth: 'none', headers: { Authorization: `Bearer ${t.data.token}` } })).status, 200);
  assert.equal((await call('DELETE', `/tokens/${t.data.id}`, { auth: 'cookie' })).status, 200);
  assert.equal((await call('GET', '/auth/me', { auth: 'none', headers: { Authorization: `Bearer ${t.data.token}` } })).status, 401);
});

test('spec sync is idempotent, updates, and can retire removed tests', async () => {
  const cases = [
    { automation_ref: 'com.bank.LoginTest#valid', title: 'Valid login', suite: 'Login', priority: 'High', requirement_ref: 'PAY-1', steps: [{ action: 'Open app', expected_result: 'Login shown' }] },
    { automation_ref: 'com.bank.LoginTest#locked', title: 'Lock after 3 attempts', suite: 'Login' },
  ];
  const first = await call('PUT', '/projects/CBS/automation/cases', { body: { cases } });
  assert.equal(first.status, 200);
  assert.equal(first.data.created, 2);
  assert.equal(first.data.cases[0].case_key, 'CBS-1');

  const again = await call('PUT', '/projects/CBS/automation/cases', { body: { cases } });
  assert.equal(again.data.created, 0);
  assert.equal(again.data.unchanged, 2);

  cases[0].title = 'Valid login (renamed)';
  const upd = await call('PUT', `/projects/${projectId}/automation/cases`, { body: { cases } });
  assert.equal(upd.data.updated, 1);
  const tree = await call('GET', `/projects/${projectId}/tree`, { auth: 'cookie' });
  const c = tree.data.cases.find((x) => x.case_key === 'CBS-1');
  assert.equal(c.title, 'Valid login (renamed)');
  assert.equal(c.version, 2);
  assert.equal(c.execution_type, 'Automated');
  assert.equal(tree.data.suites.find((s) => s.name === 'Login')?.parent_id !== null, true); // under "Automation"

  const dry = await call('PUT', '/projects/CBS/automation/cases', { body: { cases: [cases[0]], obsolete_missing: true, dry_run: true } });
  assert.equal(dry.data.obsoleted, 1);
  const stillThere = await call('GET', '/cases/2', { auth: 'cookie' });
  assert.equal(stillThere.data.status, 'Ready', 'dry run must not change anything');

  const real = await call('PUT', '/projects/CBS/automation/cases', { body: { cases: [cases[0]], obsolete_missing: true } });
  assert.equal(real.data.obsoleted, 1);
  assert.equal((await call('GET', '/cases/2', { auth: 'cookie' })).data.status, 'Obsolete');
  const revive = await call('PUT', '/projects/CBS/automation/cases', { body: { cases } });
  assert.equal((await call('GET', '/cases/2', { auth: 'cookie' })).data.status, 'Ready');
  assert.equal(revive.data.errors.length, 0);
});

test('results create the plan, record executions, and respect run_id', async () => {
  const body = {
    plan: { name: 'Nightly regression', environment: 'SIT' }, build: '#101', ci_url: 'https://ci.example/run/101', run_id: 'run-101',
    results: [
      { automation_ref: 'com.bank.LoginTest#valid', status: 'passed', duration_seconds: 1.25 },
      { automation_ref: 'com.bank.LoginTest#locked', status: 'FAILED', message: 'expected locked but was open', defect_ref: 'JIRA-9', output: 'stack trace here' },
      { automation_ref: 'com.bank.NewTest#brandNew', status: 'skipped' },
      { automation_ref: 'x#y', status: 'weird' },
    ],
  };
  const r = await call('POST', '/projects/CBS/automation/results', { body });
  assert.equal(r.status, 201);
  assert.equal(r.data.recorded, 3);
  assert.equal(r.data.plan_created, true);
  assert.deepEqual(r.data.summary, { Passed: 1, Failed: 1, Blocked: 0, Skipped: 1 });
  assert.equal(r.data.created_cases.length, 1);
  assert.equal(r.data.errors.length, 1);

  const again = await call('POST', '/projects/CBS/automation/results', { body });
  assert.equal(again.data.duplicates, 3, 'same run_id must not double count');
  assert.equal(again.data.plan_created, false);

  const plan = (await call('GET', `/plans/${r.data.plan_id}`, { auth: 'cookie' })).data;
  assert.equal(plan.build_version, '#101');
  assert.equal(plan.summary.total, 3);
  assert.equal(plan.summary.Failed, 1);
  const failed = plan.cases.find((c) => c.status === 'Failed');
  const detail = (await call('GET', `/plan-cases/${failed.plan_case_id}`, { auth: 'cookie' })).data;
  const ex = detail.executions[0];
  assert.equal(ex.source, 'automation');
  assert.equal(ex.build_ref, '#101');
  assert.equal(ex.ci_url, 'https://ci.example/run/101');
  assert.equal(ex.defect_ref, 'JIRA-9');
  assert.equal(ex.attachments.length, 1, 'failure output is kept as evidence');

  // evidence upload
  const form = new FormData();
  form.append('automation_ref', 'com.bank.LoginTest#locked');
  form.append('run_id', 'run-101');
  form.append('evidence', new Blob([Buffer.from([137, 80, 78, 71])], { type: 'image/png' }), 'failure.png');
  const ev = await call('POST', `/plans/${r.data.plan_id}/automation/evidence`, { form });
  assert.equal(ev.status, 201);

  // a later run replaces the latest result
  const next = await call('POST', '/projects/CBS/automation/results', { body: { plan: { name: 'Nightly regression' }, build: '#102', run_id: 'run-102',
    results: [{ automation_ref: 'com.bank.LoginTest#locked', status: 'passed' }] } });
  assert.equal(next.data.recorded, 1);
  assert.equal((await call('GET', `/plans/${r.data.plan_id}`, { auth: 'cookie' })).data.summary.Failed, 0);
});

test('results without auto-create report unknown tests instead of creating them', async () => {
  const r = await call('POST', '/projects/CBS/automation/results', { body: { plan: { name: 'Strict' }, auto_create_cases: false,
    results: [{ automation_ref: 'does.not.Exist#t', status: 'passed' }] } });
  assert.equal(r.data.recorded, 0);
  assert.deepEqual(r.data.unmatched, ['does.not.Exist#t']);
});

test('JUnit upload creates specs and results in one call', async () => {
  const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="pytest" tests="3">
    <testcase classname="tests.test_payment" name="test_transfer_ok" time="0.5"/>
    <testcase classname="tests.test_payment" name="test_transfer_limit" time="1.2"><failure message="limit not enforced">AssertionError: 300000000 &gt; 250000000</failure></testcase>
    <testcase classname="tests.test_payment" name="test_bifast_fee"><skipped message="not ready"/></testcase>
  </testsuite>
</testsuites>`;
  const form = new FormData();
  form.append('report', new Blob([xml], { type: 'application/xml' }), 'junit.xml');
  form.append('plan_name', 'UAT smoke');
  form.append('environment', 'UAT');
  form.append('build', 'v2.4.1');
  const r = await call('POST', '/projects/CBS/automation/junit', { form });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.recorded, 3);
  assert.equal(r.data.created_cases.length, 3);
  assert.deepEqual(r.data.summary, { Passed: 1, Failed: 1, Blocked: 0, Skipped: 1 });
  const plan = (await call('GET', `/plans/${r.data.plan_id}`, { auth: 'cookie' })).data;
  assert.equal(plan.environment, 'UAT');
  assert.ok(plan.cases.some((c) => c.suite_path === 'Automation / tests / test_payment'));
  const failed = plan.cases.find((c) => c.status === 'Failed');
  const ex = (await call('GET', `/plan-cases/${failed.plan_case_id}`, { auth: 'cookie' })).data.executions[0];
  assert.match(ex.actual_result, /limit not enforced/);

  const bad = new FormData();
  bad.append('report', new Blob(['not xml'], { type: 'text/plain' }), 'x.xml');
  assert.equal((await call('POST', '/projects/CBS/automation/junit', { form: bad })).status, 400);
});

test('manual edits and copies keep automation links safe', async () => {
  const before = (await call('GET', '/cases/1', { auth: 'cookie' })).data;
  assert.equal(before.automation_ref, 'com.bank.LoginTest#valid');
  // an older client that does not send automation_ref must not wipe it
  const put = await call('PUT', '/cases/1', { auth: 'cookie', body: { title: 'Manually renamed', steps: before.steps } });
  assert.equal(put.status, 200);
  assert.equal((await call('GET', '/cases/1', { auth: 'cookie' })).data.automation_ref, 'com.bank.LoginTest#valid');
  // duplicate refs are rejected
  const dup = await call('PUT', '/cases/2', { auth: 'cookie', body: { title: 'x', automation_ref: 'com.bank.LoginTest#valid' } });
  assert.equal(dup.status, 409);
  // copies are manual tests
  const tree = (await call('GET', `/projects/${projectId}/tree`, { auth: 'cookie' })).data;
  const copy = await call('POST', '/cases/bulk', { auth: 'cookie', body: { action: 'copy', case_ids: [1], target_suite_id: tree.suites[0].id } });
  assert.equal(copy.status, 200);
  assert.equal((await call('GET', `/cases/${copy.data.created[0]}`, { auth: 'cookie' })).data.automation_ref, null);
});

test('clients cannot create tokens or use automation', async () => {
  const u = await call('POST', '/users', { auth: 'cookie', body: { username: 'bank-client', full_name: 'Client', password: 'client-pass', role: 'client' } });
  assert.equal(u.status, 201);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bank-client', password: 'client-pass' }) });
  const clientCookie = login.headers.get('set-cookie').split(';')[0];
  const t = await call('POST', '/tokens', { auth: 'none', headers: { Cookie: clientCookie }, body: { name: 'nope' } });
  assert.equal(t.status, 403);
  const forAdmin = await call('POST', '/tokens', { auth: 'cookie', body: { name: 'for client', user_id: u.data.id } });
  assert.equal(forAdmin.status, 400);
});
