import { state, api, GET, POST, PUT, DEL, project, setProject, loadProjects, can } from '../api.js';
import { esc, $, $$, modal, toast, confirmBox, formValues, options, suiteOptions, badge, progressBar, statChips, fmtDate, empty } from '../ui.js';
import { go, refresh, fillProjectSelect } from '../app.js';

/* ------------------------------------------------------------------ dashboard */

export async function renderDashboard(main) {
  const p = project();
  const plans = await GET(`/projects/${p.id}/plans`);
  const active = plans.filter((x) => x.status === 'Active');
  main.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div><h1>${esc(p.name)}</h1>
          <p class="muted">${esc(p.prefix)} · Client: ${esc(p.client_name || '-')} · Vendor: ${esc(p.vendor_name || '-')}</p></div>
        <div class="actions">
          <a class="btn" href="#/spec">Test specification</a>
          <a class="btn primary" href="#/plans">Test plans</a>
        </div>
      </div>
      <div class="cards">
        <a class="card stat" href="#/spec"><div class="v">${p.suite_count}</div><div class="l">Test suites</div></a>
        <a class="card stat" href="#/spec"><div class="v">${p.case_count}</div><div class="l">Test cases</div></a>
        <a class="card stat" href="#/plans"><div class="v">${active.length}</div><div class="l">Active test plans</div></a>
        <a class="card stat" href="#/plans"><div class="v">${plans.length - active.length}</div><div class="l">Closed test plans</div></a>
      </div>
      <h2>Active test plans</h2>
      ${active.length ? `<div class="plan-list">${active.map(planCard).join('')}</div>`
        : empty('No active test plan.', can.edit() ? '<a class="btn primary" href="#/plans">Create a test plan</a>' : '')}
    </div>`;
}

export function planCard(t) {
  return `<a class="card plan-card" href="#/plans/${t.id}">
    <div class="plan-card-head">${badge(t.environment)} <strong>${esc(t.name)}</strong> ${t.status === 'Closed' ? badge('Closed') : ''}</div>
    <div class="muted small">${esc(t.build_version || 'No build')} · ${fmtDate(t.start_date)} – ${fmtDate(t.end_date)}</div>
    ${progressBar(t.summary)}
    <div class="small">${t.summary.executed}/${t.summary.total} executed · <span class="t-passed">${t.summary.Passed} passed</span> ·
      <span class="t-failed">${t.summary.Failed} failed</span> · <span class="t-blocked">${t.summary.Blocked} blocked</span>
      ${t.environment === 'UAT' ? ` · ${t.summary.Approved} approved` : ''}</div>
  </a>`;
}

/* ------------------------------------------------------------------ projects */

export async function renderProjects(main) {
  await loadProjects();
  fillProjectSelect();
  main.innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Projects</h1>
        ${can.admin() ? '<button class="btn primary" id="newProject">New project</button>' : ''}</div>
      ${state.projects.length ? `<table class="table">
        <thead><tr><th>Prefix</th><th>Name</th><th>Client</th><th>Vendor</th><th class="num">Suites</th><th class="num">Cases</th><th class="num">Plans</th><th></th></tr></thead>
        <tbody>${state.projects.map((p) => `<tr>
          <td><b>${esc(p.prefix)}</b></td><td>${esc(p.name)}<div class="muted small">${esc(p.description || '')}</div></td>
          <td>${esc(p.client_name || '-')}</td><td>${esc(p.vendor_name || '-')}</td>
          <td class="num">${p.suite_count}</td><td class="num">${p.case_count}</td><td class="num">${p.plan_count}</td>
          <td class="row-actions">
            <button class="btn small primary" data-open="${p.id}">Open</button>
            ${can.admin() ? `<button class="btn small" data-edit="${p.id}">Edit</button><button class="btn small danger-text" data-del="${p.id}">Delete</button>` : ''}
          </td></tr>`).join('')}</tbody></table>`
        : empty('No projects yet.', can.admin() ? '' : '<p class="muted">Ask an administrator to create one.</p>')}
    </div>`;
  $('#newProject')?.addEventListener('click', () => projectForm());
  $$('[data-open]', main).forEach((b) => { b.onclick = () => { setProject(b.dataset.open); fillProjectSelect(); go('dashboard'); }; });
  $$('[data-edit]', main).forEach((b) => { b.onclick = () => projectForm(state.projects.find((p) => p.id === Number(b.dataset.edit))); });
  $$('[data-del]', main).forEach((b) => {
    b.onclick = async () => {
      const p = state.projects.find((x) => x.id === Number(b.dataset.del));
      if (!(await confirmBox(`Delete project "${p.name}" with all its suites, test cases, plans and evidence? This cannot be undone.`, { okLabel: 'Delete project' }))) return;
      await DEL(`/projects/${p.id}`).then(() => toast('Project deleted'), (e) => toast(e.message, 'error'));
      refresh();
    };
  });
}

function projectForm(p = {}) {
  modal({
    title: p.id ? 'Edit project' : 'New project',
    body: `
      <label>Project name<input name="name" value="${esc(p.name)}" required></label>
      <label>Prefix <span class="hint">used for test case IDs, e.g. CBS → CBS-1</span><input name="prefix" value="${esc(p.prefix)}" maxlength="10" required style="text-transform:uppercase"></label>
      <div class="grid2">
        <label>Client<input name="client_name" value="${esc(p.client_name)}" placeholder="PT Bank ..."></label>
        <label>Vendor<input name="vendor_name" value="${esc(p.vendor_name)}" placeholder="PT ..."></label>
      </div>
      <label>Description<textarea name="description" rows="3">${esc(p.description)}</textarea></label>`,
    onSubmit: async (form) => {
      const body = formValues(form);
      if (p.id) await PUT(`/projects/${p.id}`, body);
      else {
        const r = await POST('/projects', body);
        setProject(r.id);
      }
      toast('Project saved');
      refresh();
    },
  });
}

/* ------------------------------------------------------------------ users */

const ROLES = [['admin', 'Admin — full access'], ['tester', 'Tester / QA — write cases, execute'], ['client', 'Client — review, approve UAT, sign off']];

export async function renderUsers(main) {
  if (!can.admin()) { main.innerHTML = '<div class="page">Admins only.</div>'; return; }
  const users = await GET('/users');
  main.innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Users</h1><button class="btn primary" id="newUser">New user</button></div>
      <table class="table"><thead><tr><th>Username</th><th>Full name</th><th>Role</th><th>Company</th><th>Position</th><th>Status</th><th></th></tr></thead>
      <tbody>${users.map((u) => `<tr class="${u.active ? '' : 'inactive'}">
        <td>${esc(u.username)}</td><td>${esc(u.full_name)}<div class="muted small">${esc(u.email || '')}</div></td>
        <td>${badge(u.role, u.role === 'client' ? 'UAT' : u.role === 'admin' ? 'Failed' : 'SIT')}</td>
        <td>${esc(u.company || '-')}</td><td>${esc(u.title || '-')}</td><td>${u.active ? 'Active' : 'Inactive'}</td>
        <td class="row-actions"><button class="btn small" data-edit="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table>
    </div>`;
  $('#newUser').onclick = () => userForm();
  $$('[data-edit]', main).forEach((b) => { b.onclick = () => userForm(users.find((u) => u.id === Number(b.dataset.edit))); });
}

function userForm(u = {}) {
  modal({
    title: u.id ? `Edit user ${u.username}` : 'New user',
    body: `
      <div class="grid2">
        <label>Username<input name="username" value="${esc(u.username)}" ${u.id ? 'disabled' : 'required'}></label>
        <label>Full name<input name="full_name" value="${esc(u.full_name)}" required></label>
      </div>
      <div class="grid2">
        <label>Email<input name="email" type="email" value="${esc(u.email)}"></label>
        <label>Role<select name="role">${options(ROLES, u.role || 'tester')}</select></label>
      </div>
      <div class="grid2">
        <label>Company<input name="company" value="${esc(u.company)}"></label>
        <label>Position / title<input name="title" value="${esc(u.title)}"></label>
      </div>
      <label>${u.id ? 'New password <span class="hint">leave blank to keep</span>' : 'Password'}<input name="password" type="password" minlength="6" ${u.id ? '' : 'required'}></label>
      ${u.id ? `<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Active</label>` : ''}`,
    onSubmit: async (form) => {
      const body = formValues(form);
      if (u.id) await PUT(`/users/${u.id}`, body);
      else await POST('/users', body);
      toast('User saved');
      refresh();
    },
  });
}

/* ------------------------------------------------------------------ import / export */

export async function renderImportExport(main) {
  const p = project();
  const { suites } = await GET(`/projects/${p.id}/tree`);
  main.innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Import / Export test cases</h1></div>
      ${can.edit() ? `<section class="card pad ai-banner">
        <div><h2><span class="spark">✦</span> Generate test cases with AI</h2>
          <p class="muted">Start from requirements instead of a spreadsheet: paste a user story, attach a BRD / FSD / TSD (PDF, Word, Excel, text), or link Jira issues.
            Review the drafts, then create them directly in Test Specification, or download them in this import layout to finish in Excel and import here.</p></div>
        <a class="btn primary" href="#/generate">Open AI generator</a>
      </section>` : ''}
      <div class="two-col">
        <section class="card pad">
          <h2>Import from Excel or CSV</h2>
          <p class="muted">One row per test step. A row with a new <b>Test Case ID</b> or <b>Test Case Title</b> starts a new test case; following rows with those cells blank add steps.
            Existing IDs in this project are updated. The <b>Test Suite</b> column accepts paths such as <code>Payments / Transfer</code>; missing suites are created.
            Headers in common English and Bahasa Indonesia spellings are recognised.</p>
          <p>Template: <a href="/api/import-template?format=xlsx">Excel (.xlsx)</a> · <a href="/api/import-template?format=csv">CSV</a></p>
          ${can.edit() ? `<form id="importForm">
            <label>File (.xlsx or .csv)<input type="file" name="file" accept=".xlsx,.csv" required></label>
            <label>Import into suite <span class="hint">optional; suite paths in the file are created under it</span>
              <select name="suite_id">${suiteOptions(suites, null, { rootLabel: '(project root)' })}</select></label>
            <button class="btn primary">Import</button>
          </form>
          <div id="importResult"></div>` : '<p class="muted">You have read-only access.</p>'}
        </section>
        <section class="card pad">
          <h2>Export</h2>
          <p class="muted">Exports use the same columns as the import template, so you can edit in Excel and import again.</p>
          <form id="exportForm">
            <label>Suite<select name="suite_id">${suiteOptions(suites, null, { rootLabel: 'All test suites' })}</select></label>
            <label>Format<select name="format">${options([['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV']])}</select></label>
            <button class="btn primary">Download</button>
          </form>
        </section>
      </div>
    </div>`;
  $('#exportForm').onsubmit = (e) => {
    e.preventDefault();
    const v = formValues(e.target);
    location.href = `/api/projects/${p.id}/export?format=${v.format}${v.suite_id ? `&suite_id=${v.suite_id}` : ''}`;
  };
  $('#importForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', e.target);
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const r = await api('POST', `/projects/${p.id}/import`, new FormData(e.target));
      $('#importResult').innerHTML = `<div class="callout ${r.errors.length ? 'warn' : 'ok'}">
        <b>${r.created}</b> created · <b>${r.updated}</b> updated · <b>${r.unchanged}</b> unchanged${r.errors.length ? ` · <b>${r.errors.length}</b> skipped` : ''}
        ${r.errors.length ? `<ul>${r.errors.map((x) => `<li>Row ${x.row}: ${esc(x.message)}</li>`).join('')}</ul>` : ''}
        <p><a href="#/spec">Open test specification →</a></p></div>`;
      await loadProjects();
    } catch (err) {
      $('#importResult').innerHTML = `<div class="callout error">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  });
}

/* ------------------------------------------------------------------ reports */

export async function renderReports(main, _, query) {
  const p = project();
  const plans = await GET(`/projects/${p.id}/plans`);
  if (!plans.length) {
    main.innerHTML = `<div class="page"><h1>Reports</h1>${empty('Create and execute a test plan first.', '<a class="btn primary" href="#/plans">Test plans</a>')}</div>`;
    return;
  }
  const selected = plans.find((x) => x.id === Number(query.get('plan'))) || plans[0];
  main.innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Reports</h1></div>
      <div class="two-col">
        <form class="card pad" id="reportForm">
          <label>Test plan<select name="plan">${options(plans.map((x) => [x.id, `[${x.environment}] ${x.name}${x.status === 'Closed' ? ' (closed)' : ''}`]), selected.id)}</select></label>
          <fieldset><legend>Document</legend>
            <div class="radio-cards">
              <label><input type="radio" name="type" value="sit"> <b>SIT Report</b><span>System integration test results, defects, evidence</span></label>
              <label><input type="radio" name="type" value="uat"> <b>UAT Report</b><span>Results with client approval per test case</span></label>
              <label><input type="radio" name="type" value="bast"> <b>BAST</b><span>Berita Acara Serah Terima / handover certificate</span></label>
            </div>
          </fieldset>
          <div class="grid2">
            <label>Language<select name="lang">${options([['id', 'Bahasa Indonesia'], ['en', 'English']])}</select></label>
            <label>Format<select name="format">${options([['pdf', 'PDF'], ['html', 'HTML']])}</select></label>
          </div>
          <label>Document number <span class="hint">optional, e.g. 001/BAST/X/2026</span><input name="doc_no"></label>
          <div class="report-opts">
            <label class="check"><input type="checkbox" name="details" checked> Include test case details and steps</label>
            <label class="check"><input type="checkbox" name="evidence" checked> Include evidence screenshots</label>
          </div>
          <div class="actions">
            <button type="button" class="btn" id="preview">Preview</button>
            <button class="btn primary">Download</button>
          </div>
        </form>
        <section class="card pad" id="planSummary"></section>
      </div>
    </div>`;
  const form = $('#reportForm');
  const setType = () => {
    const plan = plans.find((x) => x.id === Number(form.plan.value));
    $$('input[name=type]', form).forEach((r) => { r.checked = r.value === (plan.environment === 'UAT' ? 'uat' : 'sit'); });
    $('#planSummary').innerHTML = `<h2>${badge(plan.environment)} ${esc(plan.name)}</h2>
      <p class="muted">${esc(plan.build_version || '')} · ${fmtDate(plan.start_date)} – ${fmtDate(plan.end_date)}</p>
      ${progressBar(plan.summary)}${statChips(plan.summary)}
      <p><a href="#/plans/${plan.id}">Open test plan →</a></p>`;
  };
  form.plan.onchange = setType;
  setType();
  const url = (download) => {
    const v = formValues(form);
    const q = new URLSearchParams({ type: v.type, lang: v.lang, format: v.format });
    if (!v.details) q.set('details', '0');
    if (!v.evidence) q.set('evidence', '0');
    if (v.doc_no) q.set('doc_no', v.doc_no);
    if (download) q.set('download', '1');
    return `/api/plans/${v.plan}/report?${q}`;
  };
  $('#preview').onclick = () => window.open(url(false), '_blank');
  form.onsubmit = (e) => {
    e.preventDefault();
    location.href = url(true);
  };
}
