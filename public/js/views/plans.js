import { state, api, GET, POST, PUT, DEL, project, setProject, can } from '../api.js';
import {
  esc, nl2br, $, $$, modal, toast, confirmBox, formValues, options, suiteTree, badge, progressBar, statChips,
  fmtDate, fmtDateTime, fmtSize, empty,
} from '../ui.js';
import { go, refresh } from '../app.js';
import { planCard } from './misc.js';

/* ------------------------------------------------------------------ plan list */

export async function renderPlans(main) {
  const p = project();
  const plans = await GET(`/projects/${p.id}/plans`);
  main.innerHTML = `
    <div class="page">
      <div class="page-head"><div><h1>Test plans</h1>
        <p class="muted">A test plan is a set of test cases executed in one environment (SIT or UAT) over a period.</p></div>
        ${can.edit() ? '<button class="btn primary" id="newPlan">New test plan</button>' : ''}</div>
      ${plans.length ? `<div class="plan-list">${plans.map(planCard).join('')}</div>`
        : empty('No test plans yet.', can.edit() ? '<p class="muted">Tip: open a suite in Test Specification and use “Run suite” to create a plan from it.</p>' : '')}
    </div>`;
  $('#newPlan')?.addEventListener('click', () => planForm(p));
}

async function planForm(p, plan = null) {
  const { suites, cases } = plan ? { suites: [], cases: [] } : await GET(`/projects/${p.id}/tree`);
  const children = suiteTree(suites);
  const count = (id) => cases.filter((c) => c.suite_id === id && c.status !== 'Obsolete').length + (children.get(id) || []).reduce((n, k) => n + count(k.id), 0);
  const suiteChecks = (parent, depth) => (children.get(parent) || []).map((s) => `
    <label class="check" style="padding-left:${depth * 18}px"><input type="checkbox" name="suite_ids" data-multi value="${s.id}"> ${esc(s.name)} <span class="muted small">(${count(s.id)})</span></label>
    ${suiteChecks(s.id, depth + 1)}`).join('');
  const t = plan || { environment: 'SIT', status: 'Active' };
  modal({
    title: plan ? 'Edit test plan' : 'New test plan',
    wide: !plan,
    body: `
      <label>Name<input name="name" value="${esc(t.name)}" required placeholder="UAT Release 2.4"></label>
      <div class="grid3">
        <label>Environment<select name="environment">${options(state.meta.environments, t.environment)}</select></label>
        <label>Build / version<input name="build_version" value="${esc(t.build_version)}" placeholder="v2.4.0"></label>
        <label>Status<select name="status">${options(['Active', 'Closed'], t.status)}</select></label>
      </div>
      <div class="grid2">
        <label>Start date<input type="date" name="start_date" value="${esc(t.start_date)}"></label>
        <label>End date<input type="date" name="end_date" value="${esc(t.end_date)}"></label>
      </div>
      <label>Description / scope<textarea name="description" rows="2">${esc(t.description)}</textarea></label>
      ${plan ? '' : `<fieldset><legend>Include test cases from suites <span class="hint">you can add or remove cases later</span></legend>
        <div class="check-tree">${suites.length ? suiteChecks(0, 0) : '<p class="muted">No suites yet.</p>'}</div></fieldset>`}`,
    onSubmit: async (form) => {
      const body = formValues(form);
      if (plan) {
        await PUT(`/plans/${plan.id}`, body);
        toast('Test plan saved');
        refresh();
      } else {
        const r = await POST('/plans', { ...body, project_id: p.id });
        go(`plans/${r.id}`);
      }
    },
  });
}

/* ------------------------------------------------------------------ plan detail */

let listFilter = { status: '', mine: false, text: '' };

export async function renderPlan(main, [planId], query) {
  const plan = await GET(`/plans/${planId}`);
  if (plan.project_id !== state.projectId) setProject(plan.project_id);
  const tab = query.get('tab') || 'execute';
  const pcId = Number(query.get('pc')) || null;
  const e = can.edit();
  const s = plan.summary;
  main.innerHTML = `
    <div class="page wide">
      <div class="page-head">
        <div>
          <div class="crumbs"><a href="#/plans">Test plans</a></div>
          <h1>${badge(plan.environment)} ${esc(plan.name)} ${plan.status === 'Closed' ? badge('Closed') : ''}</h1>
          <p class="muted">${esc(plan.build_version || 'No build')} · ${fmtDate(plan.start_date)} – ${fmtDate(plan.end_date)}${plan.description ? ` · ${esc(plan.description)}` : ''}</p>
        </div>
        <div class="actions wrap">
          ${e ? `<button class="btn" data-act="add">+ Add test cases</button><button class="btn" data-act="edit">Edit plan</button>` : ''}
          ${can.approve() && plan.environment === 'UAT' ? '<button class="btn" data-act="approveAll">Approve all passed</button>' : ''}
          <a class="btn primary" href="#/reports?plan=${plan.id}">Reports</a>
          ${e ? '<button class="btn danger-text" data-act="delete">Delete</button>' : ''}
        </div>
      </div>
      ${progressBar(s)}${statChips(s)}
      ${plan.environment === 'UAT' ? `<p class="small muted">Client approval: ${s.Approved} approved · ${s.Rejected} rejected · ${s.PendingApproval} pending</p>` : ''}
      <div class="tabs">
        <a href="#/plans/${plan.id}?tab=execute" class="${tab === 'execute' ? 'active' : ''}">Execute</a>
        <a href="#/plans/${plan.id}?tab=signoff" class="${tab === 'signoff' ? 'active' : ''}">Sign-off (${plan.signoffs.length})</a>
      </div>
      <div id="tabBody"></div>
    </div>`;

  $$('[data-act]', main).forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'edit') planForm(project(), plan);
      else if (act === 'add') addCasesForm(plan);
      else if (act === 'approveAll') {
        if (!(await confirmBox('Approve every passed test case that is still pending approval?', { okLabel: 'Approve', danger: false }))) return;
        const r = await POST(`/plans/${plan.id}/approve-passed`);
        toast(`${r.approved} result(s) approved`);
        refresh();
      } else if (act === 'delete') {
        if (!(await confirmBox(`Delete test plan "${plan.name}" with all its execution results and evidence?`, { okLabel: 'Delete plan' }))) return;
        await DEL(`/plans/${plan.id}`);
        toast('Test plan deleted');
        go('plans');
      }
    };
  });

  if (tab === 'signoff') return signoffTab($('#tabBody'), plan);
  return executeTab($('#tabBody'), plan, pcId);
}

async function addCasesForm(plan) {
  const { suites, cases } = await GET(`/projects/${plan.project_id}/tree`);
  const inPlan = new Set(plan.cases.map((c) => c.case_id));
  const children = suiteTree(suites);
  const bySuite = new Map();
  cases.filter((c) => c.status !== 'Obsolete').forEach((c) => { if (!bySuite.has(c.suite_id)) bySuite.set(c.suite_id, []); bySuite.get(c.suite_id).push(c); });
  const draw = (parent, depth) => (children.get(parent) || []).map((s) => `
    <div class="ct-suite" style="padding-left:${depth * 18}px"><label class="check"><input type="checkbox" data-suite="${s.id}"> <span class="ico folder"></span> <b>${esc(s.name)}</b></label></div>
    <div data-under="${s.id}">
      ${draw(s.id, depth + 1)}
      ${(bySuite.get(s.id) || []).map((c) => `<label class="check ct-case" style="padding-left:${depth * 18 + 26}px">
        <input type="checkbox" name="case_ids" data-multi value="${c.id}" ${inPlan.has(c.id) ? 'checked disabled' : ''}> <span class="key">${esc(c.case_key)}</span> ${esc(c.title)}</label>`).join('')}
    </div>`).join('');
  modal({
    title: 'Add test cases to plan',
    wide: true,
    body: `<p class="muted small">Ticking a suite selects all its test cases. Cases already in the plan are greyed out.</p>
      <div class="check-tree tall">${suites.length ? draw(0, 0) : 'No test cases yet.'}</div>`,
    submitLabel: 'Add selected',
    onOpen: (form) => {
      form.addEventListener('change', (ev) => {
        const sid = ev.target.dataset.suite;
        if (sid) $$(`[data-under="${sid}"] input:not(:disabled)`, form).forEach((i) => { i.checked = ev.target.checked; });
      });
    },
    onSubmit: async (form) => {
      const ids = $$('input[name=case_ids]:checked:not(:disabled)', form).map((i) => Number(i.value));
      if (!ids.length) throw new Error('Select at least one test case');
      const r = await POST(`/plans/${plan.id}/cases`, { case_ids: ids });
      toast(`${r.added} test case(s) added`);
      refresh();
    },
  });
}

/* ------------------------------------------------------------------ execute tab */

const STATUSES = ['Passed', 'Failed', 'Blocked', 'Skipped'];

async function executeTab(body, plan, pcId) {
  const e = can.edit();
  const users = e ? await GET('/users') : [];
  body.innerHTML = `
    <div class="split exec">
      <aside class="tree-panel">
        <div class="tree-tools">
          <input type="search" id="pcFilter" placeholder="Filter" value="${esc(listFilter.text)}">
          <select id="statusFilter">${options([['', 'All'], 'Not Run', ...STATUSES], listFilter.status)}</select>
        </div>
        <label class="check small pad-x"><input type="checkbox" id="mineFilter" ${listFilter.mine ? 'checked' : ''}> Assigned to me</label>
        ${e ? `<div class="bulkbar small" id="pcBulk" hidden><span id="pcCount"></span>
          <select id="assignTo">${options([['', 'Assign to…'], ['0', '(nobody)'], ...users.filter((u) => u.active).map((u) => [u.id, u.full_name])])}</select>
          <button class="btn small danger-text" id="pcRemove">Remove</button></div>` : ''}
        <div class="tree" id="pcList"></div>
      </aside>
      <section class="detail" id="execPanel"></section>
    </div>`;

  const drawList = () => {
    const f = listFilter.text.toLowerCase();
    const rows = plan.cases.filter((c) => (!listFilter.status || c.status === listFilter.status)
      && (!listFilter.mine || c.assigned_to === state.user.id)
      && (!f || `${c.case_key} ${c.title}`.toLowerCase().includes(f)));
    let lastSuite = null;
    let html = '';
    for (const c of rows) {
      if (c.suite_path !== lastSuite) {
        lastSuite = c.suite_path;
        html += `<div class="node group"><span class="ico folder"></span> ${esc(c.suite_path)}</div>`;
      }
      html += `<div class="node case exec-node ${c.plan_case_id === pcId ? 'selected' : ''}" data-pc="${c.plan_case_id}">
        ${e ? `<input type="checkbox" class="pc-chk" value="${c.plan_case_id}" aria-label="Select">` : ''}
        <span class="dot ${statusCls(c.status)}" title="${esc(c.status)}"></span>
        <span class="key">${esc(c.case_key)}</span><span class="name">${esc(c.title)}</span>
        ${c.approval_status === 'Approved' ? '<span class="tick" title="Approved by client">✔</span>' : c.approval_status === 'Rejected' ? '<span class="cross" title="Rejected by client">✖</span>' : ''}
      </div>`;
    }
    $('#pcList').innerHTML = html || `<p class="muted pad">${plan.cases.length ? 'No match.' : 'This plan has no test cases yet.'}</p>`;
  };
  drawList();

  $('#pcFilter').oninput = (ev) => { listFilter.text = ev.target.value; drawList(); };
  $('#statusFilter').onchange = (ev) => { listFilter.status = ev.target.value; drawList(); };
  $('#mineFilter').onchange = (ev) => { listFilter.mine = ev.target.checked; drawList(); };
  const selectedPcs = () => $$('.pc-chk:checked').map((i) => Number(i.value));
  $('#pcList').onclick = (ev) => {
    if (ev.target.classList.contains('pc-chk')) {
      const n = selectedPcs().length;
      $('#pcBulk').hidden = !n;
      $('#pcCount').textContent = `${n} selected`;
      return;
    }
    const node = ev.target.closest('[data-pc]');
    if (node) go(`plans/${plan.id}?pc=${node.dataset.pc}`);
  };
  $('#assignTo')?.addEventListener('change', async (ev) => {
    if (!ev.target.value) return;
    await POST(`/plans/${plan.id}/assign`, { plan_case_ids: selectedPcs(), user_id: Number(ev.target.value) || null });
    toast('Assignment updated');
    refresh();
  });
  $('#pcRemove')?.addEventListener('click', async () => {
    const ids = selectedPcs();
    const executed = plan.cases.filter((c) => ids.includes(c.plan_case_id) && c.run_count).length;
    if (!(await confirmBox(`Remove ${ids.length} test case(s) from this plan?${executed ? `\n${executed} of them have execution results and evidence, which will be deleted.` : ''}`, { okLabel: 'Remove' }))) return;
    await POST(`/plans/${plan.id}/cases/remove`, { plan_case_ids: ids });
    toast('Removed from plan');
    go(`plans/${plan.id}`);
  });

  const panel = $('#execPanel');
  const target = pcId || plan.cases.find((c) => c.status === 'Not Run')?.plan_case_id || plan.cases[0]?.plan_case_id;
  if (!target) {
    panel.innerHTML = empty('Add test cases to this plan to start executing.', e ? '<button class="btn primary" id="addFromEmpty">+ Add test cases</button>' : '');
    $('#addFromEmpty')?.addEventListener('click', () => addCasesForm(plan));
    return;
  }
  if (!pcId) {
    $(`[data-pc="${target}"]`)?.classList.add('selected');
  }
  $(`[data-pc="${target}"]`)?.scrollIntoView({ block: 'nearest' });
  await executionPanel(panel, plan, target);
}

const statusCls = (s) => ({ Passed: 'passed', Failed: 'failed', Blocked: 'blocked', Skipped: 'skipped' }[s] || 'notrun');

async function executionPanel(panel, plan, pcId) {
  const { plan_case: pc, case: c, executions } = await GET(`/plan-cases/${pcId}`);
  const e = can.edit() && plan.status !== 'Closed';
  const idx = plan.cases.findIndex((x) => x.plan_case_id === pcId);
  const next = plan.cases[idx + 1];
  const last = executions[0];
  const changedSince = last && last.case_version && last.case_version !== c.version;

  panel.innerHTML = `
    <div class="detail-head">
      <div><div class="crumbs">${esc(c.suite_path)}</div>
        <h1><span class="key">${esc(c.case_key)}</span> ${esc(c.title)}</h1>
        <div class="meta-row">${badge(c.priority)} <span class="tag">${esc(c.test_type)}</span>
          ${last ? badge(last.status) : badge('Not Run')} <span class="muted small">Assigned: ${esc(pc.assigned_name || '-')} · v${c.version}</span>
          ${c.requirement_ref ? `<span class="tag">${esc(c.requirement_ref)}</span>` : ''}</div>
      </div>
      <div class="actions">
        <a class="btn small" href="#/spec?case=${c.id}">Open test case</a>
        ${next ? `<a class="btn small" href="#/plans/${plan.id}?pc=${next.plan_case_id}">Next →</a>` : ''}
      </div>
    </div>
    ${changedSince ? `<div class="callout warn small">This test case changed (now v${c.version}) after it was last executed (v${last.case_version}). Re-run it to record a result against the current version.</div>` : ''}
    ${plan.status === 'Closed' ? '<div class="callout small">This test plan is closed. Reopen it with “Edit plan” to record new results.</div>' : ''}
    ${c.objective ? `<div class="field"><div class="label">Objective</div><div>${nl2br(c.objective)}</div></div>` : ''}
    ${c.preconditions ? `<div class="field"><div class="label">Preconditions</div><div>${nl2br(c.preconditions)}</div></div>` : ''}
    ${e ? executionForm(c) : stepsReadOnly(c)}
    <h3>Execution history (${executions.length})</h3>
    <div id="history">${executions.length ? executions.map((x, i) => historyCard(x, i === 0, plan)).join('') : '<p class="muted">Not executed yet.</p>'}</div>`;

  if (e) wireExecutionForm(panel, plan, pc, c, next);
  wireHistory(panel, plan);
}

function stepsReadOnly(c) {
  return c.steps.length ? `<h3>Test steps</h3><table class="table steps"><thead><tr><th class="num">#</th><th>Test step</th><th>Test data</th><th>Expected result</th></tr></thead>
    <tbody>${c.steps.map((s) => `<tr><td class="num">${s.step_no}</td><td>${nl2br(s.action)}</td><td>${nl2br(s.test_data || '')}</td><td>${nl2br(s.expected_result || '')}</td></tr>`).join('')}</tbody></table>` : '';
}

function executionForm(c) {
  return `
    <form id="execForm" class="exec-form">
      ${c.steps.length ? `<table class="table steps exec-steps"><thead><tr><th class="num">#</th><th>Test step</th><th>Expected result</th><th>Actual result</th><th>Result</th></tr></thead>
        <tbody>${c.steps.map((s) => `<tr data-step="${s.step_no}">
          <td class="num">${s.step_no}</td>
          <td>${nl2br(s.action)}${s.test_data ? `<div class="muted small">Data: ${nl2br(s.test_data)}</div>` : ''}</td>
          <td>${nl2br(s.expected_result || '')}</td>
          <td><textarea rows="1" data-f="actual_result" placeholder="As expected"></textarea></td>
          <td><div class="step-result" role="radiogroup">${STATUSES.slice(0, 3).map((st) => `<button type="button" class="seg ${statusCls(st)}" data-v="${st}" title="${st}">${st[0]}</button>`).join('')}</div></td>
        </tr>`).join('')}</tbody></table>
        <button type="button" class="btn small" id="allPass">Mark all steps passed</button>` : ''}
      <fieldset class="result-pick"><legend>Overall result</legend>
        ${STATUSES.map((st) => `<label class="result-btn ${statusCls(st)}"><input type="radio" name="status" value="${st}"> ${st}</label>`).join('')}
      </fieldset>
      <div class="grid2">
        <label>Actual result <span class="hint">required when failed</span><textarea name="actual_result" rows="2"></textarea></label>
        <label>Notes<textarea name="notes" rows="2"></textarea></label>
      </div>
      <div class="grid2">
        <label>Defect / bug reference<input name="defect_ref" placeholder="JIRA-123"></label>
        <label>Duration (minutes)<input name="duration_minutes" type="number" min="0"></label>
      </div>
      <div class="dropzone" id="dropzone" tabindex="0">
        <input type="file" id="evidenceInput" multiple hidden>
        <p><b>Evidence</b> — drop screenshots or files here, <button type="button" class="linklike" id="browse">browse</button>, or paste a screenshot (Ctrl+V)</p>
        <div class="thumbs" id="thumbs"></div>
      </div>
      <div class="form-error" id="execError"></div>
      <div class="actions">
        <button type="submit" class="btn primary">Save result</button>
        <button type="submit" class="btn" data-next="1">Save & next</button>
      </div>
    </form>`;
}

function wireExecutionForm(panel, plan, pc, c, next) {
  const form = $('#execForm', panel);
  const files = [];
  const stepStatus = {};

  const drawThumbs = () => {
    $('#thumbs').innerHTML = files.map((f, i) => `<div class="thumb">
      ${f.type.startsWith('image/') ? `<img src="${URL.createObjectURL(f)}" alt="">` : `<div class="file-ico">${esc((f.name.split('.').pop() || 'file').toUpperCase())}</div>`}
      <span title="${esc(f.name)}">${esc(f.name)}</span><small>${fmtSize(f.size)}</small>
      <button type="button" class="icon-btn" data-rm="${i}" title="Remove">✕</button></div>`).join('');
  };
  const addFiles = (list) => {
    for (const f of list) files.push(f);
    drawThumbs();
  };
  $('#browse').onclick = () => $('#evidenceInput').click();
  $('#evidenceInput').onchange = (ev) => { addFiles(ev.target.files); ev.target.value = ''; };
  $('#thumbs').onclick = (ev) => {
    const rm = ev.target.closest('[data-rm]');
    if (rm) { files.splice(Number(rm.dataset.rm), 1); drawThumbs(); }
  };
  const dz = $('#dropzone');
  dz.addEventListener('dragover', (ev) => { ev.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (ev) => { ev.preventDefault(); dz.classList.remove('over'); addFiles(ev.dataTransfer.files); });
  const onPaste = (ev) => {
    if (!document.body.contains(form)) { document.removeEventListener('paste', onPaste); return; }
    const imgs = [...(ev.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (!imgs.length) return;
    ev.preventDefault();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    addFiles(imgs.map((f, i) => new File([f], f.name && f.name !== 'image.png' ? f.name : `screenshot-${c.case_key}-${stamp}${i ? `-${i}` : ''}.png`, { type: f.type })));
    toast('Screenshot added');
  };
  document.addEventListener('paste', onPaste);

  const setOverall = (st) => { const r = $(`input[name=status][value="${st}"]`, form); if (r) r.checked = true; };
  const deriveOverall = () => {
    const vals = Object.values(stepStatus);
    if (vals.includes('Failed')) setOverall('Failed');
    else if (vals.includes('Blocked')) setOverall('Blocked');
    else if (vals.length === c.steps.length && vals.every((v) => v === 'Passed')) setOverall('Passed');
  };
  $$('.step-result', form).forEach((group) => {
    group.onclick = (ev) => {
      const b = ev.target.closest('[data-v]');
      if (!b) return;
      const stepNo = Number(group.closest('tr').dataset.step);
      const on = !b.classList.contains('on');
      $$('.seg', group).forEach((x) => x.classList.remove('on'));
      if (on) { b.classList.add('on'); stepStatus[stepNo] = b.dataset.v; } else delete stepStatus[stepNo];
      deriveOverall();
    };
  });
  $('#allPass')?.addEventListener('click', () => {
    $$('.step-result', form).forEach((group) => {
      $$('.seg', group).forEach((x) => x.classList.toggle('on', x.dataset.v === 'Passed'));
      stepStatus[Number(group.closest('tr').dataset.step)] = 'Passed';
    });
    deriveOverall();
  });

  let goNext = false;
  $$('[type=submit]', form).forEach((b) => { b.onclick = () => { goNext = !!b.dataset.next; }; });
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const v = formValues(form);
    const err = $('#execError');
    err.textContent = '';
    if (!v.status) { err.textContent = 'Choose the overall result.'; return; }
    if (v.status === 'Failed' && !v.actual_result.trim()) { err.textContent = 'Describe the actual result for a failed test.'; return; }
    v.steps = $$('tr[data-step]', form).map((tr) => ({
      step_no: Number(tr.dataset.step), status: stepStatus[tr.dataset.step] || null, actual_result: $('textarea', tr).value,
    }));
    const fd = new FormData();
    fd.append('data', JSON.stringify(v));
    files.forEach((f) => fd.append('evidence', f, f.name));
    const btns = $$('[type=submit]', form);
    btns.forEach((b) => { b.disabled = true; });
    try {
      await api('POST', `/plan-cases/${pc.id}/executions`, fd);
      toast(`${c.case_key}: ${v.status}`);
      document.removeEventListener('paste', onPaste);
      go(`plans/${plan.id}?pc=${goNext && next ? next.plan_case_id : pc.id}&t=${Date.now()}`);
    } catch (ex) {
      err.textContent = ex.message;
      btns.forEach((b) => { b.disabled = false; });
    }
  };
}

function historyCard(x, latest, plan) {
  const images = x.attachments.filter((a) => /^image\//.test(a.mime_type || ''));
  const others = x.attachments.filter((a) => !images.includes(a));
  const editable = can.edit() && x.approval_status !== 'Approved';
  return `<div class="history ${latest ? 'latest' : ''}" data-exec="${x.id}">
    <div class="history-head">
      ${badge(x.status)} <b>${esc(x.executed_by_name || '-')}</b> <span class="muted small">${fmtDateTime(x.executed_at)} · v${x.case_version || '?'}</span>
      ${x.defect_ref ? `<span class="tag">${esc(x.defect_ref)}</span>` : ''}
      ${x.source === 'automation' ? `<span class="tag auto" title="Reported by test automation">🤖 automated${x.build_ref ? ` · build ${esc(x.build_ref)}` : ''}${x.duration_ms != null ? ` · ${(x.duration_ms / 1000).toFixed(1)}s` : ''}</span>` : ''}
      ${x.ci_url && /^https?:\/\//i.test(x.ci_url) ? `<a class="small" href="${esc(x.ci_url)}" target="_blank" rel="noopener">CI run ↗</a>` : ''}
      <span class="spacer"></span>
      ${badge(`Approval: ${x.approval_status}`, x.approval_status)}
    </div>
    ${x.actual_result ? `<div><span class="label">Actual:</span> ${nl2br(x.actual_result)}</div>` : ''}
    ${x.notes ? `<div><span class="label">Notes:</span> ${nl2br(x.notes)}</div>` : ''}
    ${x.approval_status !== 'Pending' ? `<div class="small muted">${esc(x.approval_status)} by ${esc(x.approved_by_name || '-')} · ${fmtDateTime(x.approved_at)}${x.approval_note ? ` — ${esc(x.approval_note)}` : ''}</div>` : ''}
    ${x.steps.some((s) => s.status || s.actual_result) ? `<details><summary class="small">Step results</summary>
      <table class="table steps small"><tbody>${x.steps.map((s) => `<tr><td class="num">${s.step_no}</td><td>${nl2br(s.action)}</td><td>${s.status ? badge(s.status) : '-'}</td><td>${nl2br(s.actual_result || '')}</td></tr>`).join('')}</tbody></table></details>` : ''}
    ${x.attachments.length ? `<div class="evidence-grid">
      ${images.map((a) => `<figure><a href="/api/attachments/${a.id}" target="_blank" rel="noopener"><img src="/api/attachments/${a.id}" alt="${esc(a.original_name)}" loading="lazy"></a>
        <figcaption>${esc(a.original_name)}${editable ? ` <button class="icon-btn" data-del-att="${a.id}" title="Delete">✕</button>` : ''}</figcaption></figure>`).join('')}
      ${others.map((a) => `<div class="file"><a href="/api/attachments/${a.id}?download=1">${esc(a.original_name)}</a> <small>${fmtSize(a.size)}</small>${editable ? ` <button class="icon-btn" data-del-att="${a.id}" title="Delete">✕</button>` : ''}</div>`).join('')}
    </div>` : ''}
    <div class="history-actions">
      ${can.edit() && plan.status !== 'Closed' ? `<label class="btn small">+ Evidence<input type="file" multiple hidden data-add-ev="${x.id}"></label>` : ''}
      ${can.approve() ? `<button class="btn small ok" data-approve="Approved">Approve</button><button class="btn small danger-text" data-approve="Rejected">Reject</button>
        ${x.approval_status !== 'Pending' ? '<button class="btn small" data-approve="Pending">Reset approval</button>' : ''}` : ''}
      ${editable ? '<button class="btn small danger-text" data-del-exec>Delete run</button>' : ''}
    </div>
  </div>`;
}

function wireHistory(panel, plan) {
  $('#history', panel).onclick = async (ev) => {
    const card = ev.target.closest('[data-exec]');
    if (!card) return;
    const id = card.dataset.exec;
    const approve = ev.target.closest('[data-approve]');
    const delAtt = ev.target.closest('[data-del-att]');
    if (approve) {
      const decision = approve.dataset.approve;
      if (decision === 'Pending') {
        await POST(`/executions/${id}/approval`, { decision }).then(() => refresh(), (e) => toast(e.message, 'error'));
        return;
      }
      modal({
        title: decision === 'Approved' ? 'Approve result' : 'Reject result',
        body: `<label>${decision === 'Rejected' ? 'Reason' : 'Note (optional)'}<textarea name="note" rows="3" ${decision === 'Rejected' ? 'required' : ''}></textarea></label>`,
        submitLabel: decision === 'Approved' ? 'Approve' : 'Reject',
        danger: decision === 'Rejected',
        onSubmit: async (form) => {
          await POST(`/executions/${id}/approval`, { decision, note: formValues(form).note });
          toast(`Result ${decision.toLowerCase()}`);
          refresh();
        },
      });
    } else if (delAtt) {
      if (!(await confirmBox('Delete this evidence file?', { okLabel: 'Delete' }))) return;
      await DEL(`/attachments/${delAtt.dataset.delAtt}`).then(() => refresh(), (e) => toast(e.message, 'error'));
    } else if (ev.target.closest('[data-del-exec]')) {
      if (!(await confirmBox('Delete this execution run and its evidence?', { okLabel: 'Delete run' }))) return;
      await DEL(`/executions/${id}`).then(() => refresh(), (e) => toast(e.message, 'error'));
    }
  };
  $$('[data-add-ev]', panel).forEach((input) => {
    input.onchange = async () => {
      const fd = new FormData();
      [...input.files].forEach((f) => fd.append('evidence', f, f.name));
      try {
        await api('POST', `/executions/${input.dataset.addEv}/attachments`, fd);
        toast('Evidence added');
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

/* ------------------------------------------------------------------ sign-off tab */

function signoffTab(body, plan) {
  const u = state.user;
  const parties = [];
  if (['admin', 'tester'].includes(u.role)) parties.push(['vendor', `Vendor — ${plan.project.vendor_name || 'vendor'}`]);
  if (['admin', 'client'].includes(u.role)) parties.push(['client', `Client — ${plan.project.client_name || 'client'}`]);
  const defaultParty = u.role === 'tester' ? 'vendor' : 'client';
  const s = plan.summary;
  body.innerHTML = `
    <div class="two-col">
      <section>
        <h2>Sign-offs</h2>
        <p class="muted small">The latest sign-off of each party appears on the SIT/UAT report and the BAST document.</p>
        ${plan.signoffs.length ? plan.signoffs.slice().reverse().map((x) => `<div class="history">
          <div class="history-head"><b>${x.party === 'vendor' ? 'Vendor' : 'Client'}</b> ${badge(x.decision)} <span class="spacer"></span>
            <span class="muted small">${fmtDateTime(x.signed_at)}</span></div>
          <div><b>${esc(x.signer_name)}</b>${x.signer_title ? `, ${esc(x.signer_title)}` : ''}${x.company ? ` — ${esc(x.company)}` : ''}</div>
          ${x.note ? `<div class="small">${nl2br(x.note)}</div>` : ''}
          ${u.role === 'admin' || x.user_id === u.id ? `<div class="history-actions"><button class="btn small danger-text" data-withdraw="${x.id}">Withdraw</button></div>` : ''}
        </div>`).join('') : '<p class="muted">No sign-off yet.</p>'}
      </section>
      <section class="card pad">
        <h2>Sign this test plan</h2>
        <div class="small">${statChips(s)}</div>
        ${s['Not Run'] || s.Failed || s.Blocked ? `<div class="callout warn small">${s['Not Run']} not run, ${s.Failed} failed, ${s.Blocked} blocked. Consider “Approved with notes” or “Rejected”.</div>` : ''}
        <form id="signForm">
          <label>Signing as<select name="party">${options(parties, defaultParty)}</select></label>
          <div class="grid2">
            <label>Name<input name="signer_name" value="${esc(u.full_name)}" required></label>
            <label>Position<input name="signer_title" value="${esc(u.title)}"></label>
          </div>
          <label>Company<input name="company" value="${esc(u.company || (defaultParty === 'vendor' ? plan.project.vendor_name : plan.project.client_name))}"></label>
          <label>Decision<select name="decision">${options(['Approved', 'Approved with notes', 'Rejected'])}</select></label>
          <label>Notes<textarea name="note" rows="3"></textarea></label>
          <label class="check"><input type="checkbox" name="confirm" required> I confirm that I have reviewed the test results of this plan.</label>
          <div class="form-error" id="signError"></div>
          <button class="btn primary">Sign</button>
        </form>
      </section>
    </div>`;
  $('#signForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const v = formValues(ev.target);
    if (!v.confirm) { $('#signError').textContent = 'Tick the confirmation box.'; return; }
    try {
      await POST(`/plans/${plan.id}/signoffs`, v);
      toast('Signed');
      refresh();
    } catch (e) { $('#signError').textContent = e.message; }
  };
  $$('[data-withdraw]', body).forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmBox('Withdraw this sign-off?', { okLabel: 'Withdraw' }))) return;
      await DEL(`/signoffs/${b.dataset.withdraw}`);
      refresh();
    };
  });
}
