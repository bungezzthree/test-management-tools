import { state, GET, POST, PUT, DEL, project, can, loadProjects } from '../api.js';
import {
  esc, nl2br, $, $$, modal, toast, confirmBox, formValues, options, suiteTree, suiteOptions, suitePathOf, badge, fmtDateTime, empty,
} from '../ui.js';
import { go } from '../app.js';

let expanded = new Set();
try { expanded = new Set(JSON.parse(localStorage.getItem('tm.expanded') || '[]')); } catch { /* storage unavailable */ }
let treeScroll = 0;
let filterText = '';
const saveExpanded = () => { try { localStorage.setItem('tm.expanded', JSON.stringify([...expanded])); } catch { /* ignore */ } };

const specUrl = (q = '') => `spec${q ? `?${q}` : ''}`;

export async function renderSpec(main, _, query) {
  const p = project();
  const data = await GET(`/projects/${p.id}/tree`);
  const ctx = { p, ...data, children: suiteTree(data.suites), casesBySuite: new Map() };
  for (const c of data.cases) {
    if (!ctx.casesBySuite.has(c.suite_id)) ctx.casesBySuite.set(c.suite_id, []);
    ctx.casesBySuite.get(c.suite_id).push(c);
  }
  ctx.sel = {
    suite: Number(query.get('suite')) || null,
    case: Number(query.get('case')) || null,
    edit: Number(query.get('edit')) || null,
    newIn: Number(query.get('new')) || null,
  };
  const focusCase = ctx.sel.case || ctx.sel.edit;
  const focusSuite = ctx.sel.suite || ctx.sel.newIn || data.cases.find((c) => c.id === focusCase)?.suite_id;
  for (let s = data.suites.find((x) => x.id === focusSuite); s; s = data.suites.find((x) => x.id === s.parent_id)) expanded.add(s.id);

  main.innerHTML = `
    <div class="split">
      <aside class="tree-panel">
        <div class="tree-tools">
          <input type="search" id="treeFilter" placeholder="Filter by ID or title" value="${esc(filterText)}">
          ${can.edit() ? `<button class="btn small primary" id="addRootSuite" title="New top-level suite">+ Suite</button>
          <a class="btn small ai" href="#/generate${ctx.sel.suite ? `?suite=${ctx.sel.suite}` : ''}" title="Generate test cases with AI">✦ AI</a>` : ''}
        </div>
        <div class="tree" id="tree"></div>
      </aside>
      <section class="detail" id="detail"></section>
    </div>`;

  drawTree(ctx);
  $('#tree').scrollTop = treeScroll;
  $('#tree').addEventListener('scroll', (e) => { treeScroll = e.target.scrollTop; });
  $('#treeFilter').oninput = (e) => { filterText = e.target.value; drawTree(ctx); };
  $('#addRootSuite')?.addEventListener('click', () => suiteForm(ctx, { parent_id: null }));

  const detail = $('#detail');
  if (ctx.sel.edit) await caseForm(detail, ctx, ctx.sel.edit);
  else if (ctx.sel.newIn) await caseForm(detail, ctx, null, ctx.sel.newIn);
  else if (ctx.sel.case) await caseView(detail, ctx, ctx.sel.case);
  else if (ctx.sel.suite && data.suites.some((s) => s.id === ctx.sel.suite)) suiteView(detail, ctx, ctx.sel.suite);
  else overview(detail, ctx);
}

/* ------------------------------------------------------------------ tree */

function subtreeCount(ctx, id) {
  return (ctx.casesBySuite.get(id)?.length || 0) + (ctx.children.get(id) || []).reduce((n, c) => n + subtreeCount(ctx, c.id), 0);
}

function drawTree(ctx) {
  const tree = $('#tree');
  const f = filterText.trim().toLowerCase();
  if (f) {
    const hits = ctx.cases.filter((c) => `${c.case_key} ${c.title}`.toLowerCase().includes(f));
    tree.innerHTML = hits.length ? hits.map((c) => caseNode(ctx, c, 0, true)).join('') : '<p class="muted pad">No match.</p>';
  } else if (!ctx.suites.length) {
    tree.innerHTML = `<p class="muted pad">No test suites yet.${can.edit() ? ' Create one with “+ Suite”, or import from Excel.' : ''}</p>`;
  } else {
    tree.innerHTML = (ctx.children.get(0) || []).map((s) => suiteNode(ctx, s, 0)).join('');
  }
  tree.onclick = (e) => {
    const toggle = e.target.closest('[data-toggle]');
    const node = e.target.closest('[data-suite],[data-case]');
    if (!node) return;
    if (toggle && node.dataset.suite) {
      const id = Number(node.dataset.suite);
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      saveExpanded();
      drawTree(ctx);
      return;
    }
    if (node.dataset.suite) {
      expanded.add(Number(node.dataset.suite));
      saveExpanded();
      go(specUrl(`suite=${node.dataset.suite}`));
    } else go(specUrl(`case=${node.dataset.case}`));
  };
}

function suiteNode(ctx, s, depth) {
  const kids = ctx.children.get(s.id) || [];
  const cases = ctx.casesBySuite.get(s.id) || [];
  const open = expanded.has(s.id);
  const hasKids = kids.length || cases.length;
  const selected = ctx.sel.suite === s.id && !ctx.sel.case;
  let html = `<div class="node suite ${selected ? 'selected' : ''}" data-suite="${s.id}" style="padding-left:${depth * 16 + 4}px">
    <span class="caret" data-toggle>${hasKids ? (open ? '▾' : '▸') : ''}</span><span class="ico folder"></span>
    <span class="name">${esc(s.name)}</span><span class="count">${subtreeCount(ctx, s.id)}</span></div>`;
  if (open) {
    html += kids.map((k) => suiteNode(ctx, k, depth + 1)).join('');
    html += cases.map((c) => caseNode(ctx, c, depth + 1)).join('');
  }
  return html;
}

function caseNode(ctx, c, depth, flat = false) {
  const selected = ctx.sel.case === c.id || ctx.sel.edit === c.id;
  return `<div class="node case ${selected ? 'selected' : ''} ${c.status === 'Obsolete' ? 'obsolete' : ''}" data-case="${c.id}" style="padding-left:${depth * 16 + 22}px" title="${esc(c.title)}">
    <span class="ico doc"></span><span class="key">${esc(c.case_key)}</span><span class="name">${esc(c.title)}</span>
    ${flat ? `<span class="muted small">${esc(suitePathOf(ctx.suites, c.suite_id))}</span>` : ''}</div>`;
}

/* ------------------------------------------------------------------ overview */

function overview(detail, ctx) {
  const roots = ctx.children.get(0) || [];
  detail.innerHTML = `
    <div class="detail-head"><div><h1>Test specification</h1><p class="muted">${esc(ctx.p.name)} · ${ctx.suites.length} suites · ${ctx.cases.length} test cases</p></div>
      <div class="actions">
        ${can.edit() ? '<a class="btn ai" href="#/generate">✦ Generate with AI</a><button class="btn" id="newSuite2">New suite</button><a class="btn" href="#/import">Import from Excel</a>' : ''}
      </div></div>
    ${roots.length ? `<table class="table"><thead><tr><th>Suite</th><th class="num">Test cases</th></tr></thead><tbody>
      ${roots.map((s) => `<tr class="link" data-go="${s.id}"><td><span class="ico folder"></span> ${esc(s.name)}<div class="muted small">${esc(s.description || '')}</div></td><td class="num">${subtreeCount(ctx, s.id)}</td></tr>`).join('')}
      </tbody></table>` : empty('Organise test cases into suites (folders) such as modules or features. Suites can be nested, renamed, moved and copied.')}`;
  $('#newSuite2')?.addEventListener('click', () => suiteForm(ctx, { parent_id: null }));
  $$('[data-go]', detail).forEach((r) => { r.onclick = () => go(specUrl(`suite=${r.dataset.go}`)); });
}

/* ------------------------------------------------------------------ suite */

function suiteView(detail, ctx, suiteId) {
  const s = ctx.suites.find((x) => x.id === suiteId);
  const kids = ctx.children.get(s.id) || [];
  const cases = ctx.casesBySuite.get(s.id) || [];
  const path = suitePathOf(ctx.suites, s.id);
  const e = can.edit();
  detail.innerHTML = `
    <div class="detail-head">
      <div><div class="crumbs">${esc(path)}</div><h1><span class="ico folder big"></span> ${esc(s.name)}</h1>
        ${s.description ? `<p>${nl2br(s.description)}</p>` : ''}
        <p class="muted small">${subtreeCount(ctx, s.id)} test cases in this suite and its sub-suites</p></div>
      <div class="actions wrap">
        ${e ? `<button class="btn primary" data-act="newCase">+ Test case</button>
        <a class="btn ai" href="#/generate?suite=${s.id}">✦ Generate with AI</a>
        <button class="btn" data-act="newChild">+ Sub-suite</button>
        <button class="btn" data-act="edit">Rename / edit</button>
        <button class="btn" data-act="move">Move</button>
        <button class="btn" data-act="copy">Copy</button>
        <button class="btn" data-act="run">▶ Run suite</button>
        <button class="btn danger-text" data-act="delete">Delete</button>` : ''}
        <a class="btn" href="/api/projects/${ctx.p.id}/export?format=xlsx&suite_id=${s.id}">Export</a>
      </div>
    </div>
    ${kids.length ? `<h3>Sub-suites</h3><div class="chips">${kids.map((k) => `<a class="chip link" href="#/${specUrl(`suite=${k.id}`)}"><span class="ico folder"></span> ${esc(k.name)} <b>${subtreeCount(ctx, k.id)}</b></a>`).join('')}</div>` : ''}
    <h3>Test cases (${cases.length})</h3>
    ${cases.length ? `
      ${e ? `<div class="bulkbar" id="bulkbar" hidden><span id="bulkCount"></span>
        <button class="btn small" data-bulk="move">Move to…</button><button class="btn small" data-bulk="copy">Copy to…</button>
        <button class="btn small" data-bulk="plan">Add to test plan…</button><button class="btn small danger-text" data-bulk="delete">Delete</button></div>` : ''}
      <table class="table"><thead><tr>${e ? '<th class="chk"><input type="checkbox" id="chkAll" aria-label="Select all"></th>' : ''}<th>ID</th><th>Title</th><th>Priority</th><th>Type</th><th>Status</th><th class="num">Ver.</th></tr></thead>
      <tbody>${cases.map((c) => `<tr class="link ${c.status === 'Obsolete' ? 'inactive' : ''}" data-case="${c.id}">
        ${e ? `<td class="chk"><input type="checkbox" value="${c.id}" aria-label="Select ${esc(c.case_key)}"></td>` : ''}
        <td class="nowrap"><b>${esc(c.case_key)}</b></td><td>${esc(c.title)}</td><td>${badge(c.priority)}</td><td>${esc(c.test_type)}</td><td>${badge(c.status)}</td><td class="num">${c.version}</td></tr>`).join('')}</tbody></table>`
    : empty('No test cases directly in this suite.', e ? '<button class="btn primary" data-act="newCase">+ Test case</button>' : '')}`;

  $$('[data-act]', detail).forEach((b) => {
    b.onclick = () => ({
      newCase: () => go(specUrl(`new=${s.id}`)),
      newChild: () => suiteForm(ctx, { parent_id: s.id }),
      edit: () => suiteForm(ctx, s),
      move: () => moveSuiteForm(ctx, s, false),
      copy: () => moveSuiteForm(ctx, s, true),
      run: () => runSuiteForm(ctx, s),
      delete: async () => {
        if (!(await confirmBox(`Delete suite "${s.name}" including ${kids.length} sub-suite(s) and ${subtreeCount(ctx, s.id)} test case(s)?`, { okLabel: 'Delete suite' }))) return;
        try {
          await DEL(`/suites/${s.id}`);
          toast('Suite deleted');
          await loadProjects();
          go(specUrl(s.parent_id ? `suite=${s.parent_id}` : ''));
        } catch (err) { toast(err.message, 'error'); }
      },
    })[b.dataset.act]();
  });

  const checks = () => $$('tbody .chk input', detail).filter((c) => c.checked).map((c) => Number(c.value));
  const updateBulk = () => {
    const n = checks().length;
    const bar = $('#bulkbar');
    if (bar) { bar.hidden = !n; $('#bulkCount').textContent = `${n} selected`; }
  };
  $('#chkAll')?.addEventListener('change', (ev) => { $$('tbody .chk input', detail).forEach((c) => { c.checked = ev.target.checked; }); updateBulk(); });
  $$('tbody tr[data-case]', detail).forEach((tr) => {
    tr.onclick = (ev) => {
      if (ev.target.closest('.chk')) { updateBulk(); return; }
      go(specUrl(`case=${tr.dataset.case}`));
    };
  });
  $$('[data-bulk]', detail).forEach((b) => {
    b.onclick = () => {
      const ids = checks();
      if (b.dataset.bulk === 'plan') return addToPlanForm(ctx, ids);
      if (b.dataset.bulk === 'delete') return bulkDelete(ids, s);
      return moveCasesForm(ctx, ids, b.dataset.bulk, s.id);
    };
  });
}

function suiteForm(ctx, s) {
  const isNew = !s.id;
  modal({
    title: isNew ? (s.parent_id ? `New sub-suite in "${ctx.suites.find((x) => x.id === s.parent_id).name}"` : 'New test suite') : 'Edit test suite',
    body: `<label>Suite name<input name="name" value="${esc(s.name)}" required></label>
           <label>Description<textarea name="description" rows="3">${esc(s.description)}</textarea></label>`,
    onSubmit: async (form) => {
      const v = formValues(form);
      if (isNew) {
        const r = await POST('/suites', { ...v, project_id: ctx.p.id, parent_id: s.parent_id });
        if (s.parent_id) expanded.add(s.parent_id);
        saveExpanded();
        await loadProjects();
        go(specUrl(`suite=${r.id}`));
      } else {
        await PUT(`/suites/${s.id}`, v);
        toast('Suite saved');
        go(specUrl(`suite=${s.id}&t=${Date.now()}`));
      }
    },
  });
}

function moveSuiteForm(ctx, s, copy) {
  modal({
    title: `${copy ? 'Copy' : 'Move'} suite "${s.name}"`,
    body: `<label>Destination<select name="parent_id">${suiteOptions(ctx.suites, s.parent_id, { exclude: s.id, rootLabel: '(top level)' })}</select></label>
      ${copy ? '<p class="muted small">All sub-suites and test cases are copied. Copied test cases get new IDs.</p>' : ''}`,
    submitLabel: copy ? 'Copy' : 'Move',
    onSubmit: async (form) => {
      const { parent_id } = formValues(form);
      const r = await POST(`/suites/${s.id}/${copy ? 'copy' : 'move'}`, { parent_id: parent_id || null });
      if (parent_id) expanded.add(Number(parent_id));
      saveExpanded();
      toast(copy ? 'Suite copied' : 'Suite moved');
      await loadProjects();
      go(specUrl(`suite=${copy ? r.id : s.id}&t=${Date.now()}`));
    },
  });
}

function runSuiteForm(ctx, s) {
  const today = new Date().toISOString().slice(0, 10);
  modal({
    title: `Run suite "${s.name}"`,
    body: `<p class="muted">Creates a test plan containing every test case in this suite and its sub-suites, then opens it for execution.</p>
      <label>Test plan name<input name="name" value="${esc(s.name)} — ${today}" required></label>
      <div class="grid2">
        <label>Environment<select name="environment">${options(state.meta.environments)}</select></label>
        <label>Build / version<input name="build_version"></label>
      </div>
      <div class="grid2">
        <label>Start date<input type="date" name="start_date" value="${today}"></label>
        <label>End date<input type="date" name="end_date" value="${today}"></label>
      </div>`,
    submitLabel: 'Create and run',
    onSubmit: async (form) => {
      const r = await POST('/plans', { ...formValues(form), project_id: ctx.p.id, suite_ids: [s.id] });
      go(`plans/${r.id}`);
    },
  });
}

function moveCasesForm(ctx, ids, action, currentSuite) {
  modal({
    title: `${action === 'copy' ? 'Copy' : 'Move'} ${ids.length} test case(s)`,
    body: `<label>Destination suite<select name="target_suite_id">${suiteOptions(ctx.suites, currentSuite)}</select></label>
      ${action === 'copy' ? '<p class="muted small">Copies get new test case IDs.</p>' : ''}`,
    submitLabel: action === 'copy' ? 'Copy' : 'Move',
    onSubmit: async (form) => {
      const { target_suite_id } = formValues(form);
      await POST('/cases/bulk', { action, case_ids: ids, target_suite_id });
      expanded.add(Number(target_suite_id));
      saveExpanded();
      toast(`${ids.length} test case(s) ${action === 'copy' ? 'copied' : 'moved'}`);
      await loadProjects();
      go(specUrl(`suite=${target_suite_id}&t=${Date.now()}`));
    },
  });
}

async function bulkDelete(ids, s) {
  if (!(await confirmBox(`Delete ${ids.length} test case(s)?`, { okLabel: 'Delete' }))) return;
  try {
    await POST('/cases/bulk', { action: 'delete', case_ids: ids });
    toast('Deleted');
    await loadProjects();
    go(specUrl(`suite=${s.id}&t=${Date.now()}`));
  } catch (err) { toast(err.message, 'error'); }
}

async function addToPlanForm(ctx, ids) {
  const plans = (await GET(`/projects/${ctx.p.id}/plans`)).filter((t) => t.status === 'Active');
  if (!plans.length) { toast('There is no active test plan. Create one first.', 'error'); return; }
  modal({
    title: `Add ${ids.length} test case(s) to a test plan`,
    body: `<label>Test plan<select name="plan">${options(plans.map((t) => [t.id, `[${t.environment}] ${t.name}`]))}</select></label>`,
    submitLabel: 'Add',
    onSubmit: async (form) => {
      const { plan } = formValues(form);
      const r = await POST(`/plans/${plan}/cases`, { case_ids: ids });
      toast(`${r.added} test case(s) added${r.added < ids.length ? ' (others were already in the plan or obsolete)' : ''}`);
    },
  });
}

/* ------------------------------------------------------------------ case view */

async function caseView(detail, ctx, caseId) {
  let c;
  let jiraBase = null;
  try {
    [c, { jira_base_url: jiraBase }] = await Promise.all([GET(`/cases/${caseId}`), GET('/ai/status')]);
  } catch (err) { detail.innerHTML = empty(err.message); return; }
  const e = can.edit();
  const field = (label, value) => (value ? `<div class="field"><div class="label">${label}</div><div>${nl2br(value)}</div></div>` : '');
  // Jira keys in the requirement field link to the issue when Jira is configured.
  const requirementHtml = (ref) => (jiraBase
    ? esc(ref).replace(/\b([A-Z][A-Z0-9_]{1,19}-\d{1,9})\b/g, (k) => `<a href="${esc(jiraBase)}/browse/${k}" target="_blank" rel="noopener">${k}</a>`)
    : esc(ref));
  detail.innerHTML = `
    <div class="detail-head">
      <div><div class="crumbs"><a href="#/${specUrl(`suite=${c.suite_id}`)}">${esc(c.suite_path)}</a></div>
        <h1><span class="key">${esc(c.case_key)}</span> ${esc(c.title)}</h1>
        <div class="meta-row">${badge(c.priority)} ${badge(c.status)} <span class="tag">${esc(c.test_type)}</span> <span class="tag">${esc(c.execution_type)}</span>
          <span class="muted small">Version ${c.version} · updated ${fmtDateTime(c.updated_at)} by ${esc(c.updated_by_name || '-')}</span></div></div>
      ${e ? `<div class="actions wrap">
        <button class="btn primary" data-act="edit">Edit</button>
        <button class="btn" data-act="copy">Copy to…</button>
        <button class="btn" data-act="move">Move to…</button>
        <button class="btn" data-act="plan">Add to plan…</button>
        <button class="btn danger-text" data-act="delete">Delete</button></div>` : ''}
    </div>
    <div class="fields">
      ${field('Objective / description', c.objective)}
      ${field('Preconditions', c.preconditions)}
      <div class="grid3">
        ${c.requirement_ref ? `<div class="field"><div class="label">Requirement ID</div><div>${requirementHtml(c.requirement_ref)}</div></div>` : ''}${field('Tags', c.tags)}${field('Estimated time', c.estimated_minutes ? `${c.estimated_minutes} min` : '')}
      </div>
    </div>
    <h3>Test steps</h3>
    ${c.steps.length ? `<table class="table steps"><thead><tr><th class="num">#</th><th>Test step</th><th>Test data</th><th>Expected result</th></tr></thead>
      <tbody>${c.steps.map((s) => `<tr><td class="num">${s.step_no}</td><td>${nl2br(s.action)}</td><td>${nl2br(s.test_data || '')}</td><td>${nl2br(s.expected_result || '')}</td></tr>`).join('')}</tbody></table>`
    : empty('No steps defined.')}
    ${field('Postconditions', c.postconditions)}
    <h3>Used in test plans</h3>
    ${c.plans.length ? `<div class="chips">${c.plans.map((t) => `<a class="chip link" href="#/plans/${t.id}">${badge(t.environment)} ${esc(t.name)}</a>`).join('')}</div>` : '<p class="muted">Not in any test plan yet.</p>'}`;

  $$('[data-act]', detail).forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'edit') go(specUrl(`edit=${c.id}`));
      else if (act === 'copy' || act === 'move') moveCasesForm(ctx, [c.id], act, c.suite_id);
      else if (act === 'plan') addToPlanForm(ctx, [c.id]);
      else if (act === 'delete') {
        if (!(await confirmBox(`Delete test case ${c.case_key}?`, { okLabel: 'Delete' }))) return;
        try {
          await DEL(`/cases/${c.id}`);
          toast('Test case deleted');
          await loadProjects();
          go(specUrl(`suite=${c.suite_id}`));
        } catch (err) { toast(err.message, 'error'); }
      }
    };
  });
}

/* ------------------------------------------------------------------ case form */

async function caseForm(detail, ctx, caseId, suiteId) {
  if (!can.edit()) { go(specUrl(caseId ? `case=${caseId}` : '')); return; }
  const c = caseId ? await GET(`/cases/${caseId}`) : { suite_id: suiteId, priority: 'Medium', test_type: 'Functional', execution_type: 'Manual', status: 'Ready', steps: [{}] };
  const m = state.meta;
  detail.innerHTML = `
    <form id="caseForm" class="case-form">
      <div class="detail-head">
        <div><h1>${caseId ? `Edit <span class="key">${esc(c.case_key)}</span>` : 'New test case'}</h1>
          ${caseId ? '<p class="muted small">Saving a change increases the version number. Past execution results keep the steps they were run against.</p>' : '<p class="muted small">The test case ID is assigned automatically.</p>'}</div>
        <div class="actions">
          <button type="button" class="btn" id="cancel">Cancel</button>
          ${caseId ? '' : '<button type="submit" class="btn" data-another="1">Save & add another</button>'}
          <button type="submit" class="btn primary">Save</button>
        </div>
      </div>
      <label>Title<input name="title" value="${esc(c.title)}" required maxlength="300"></label>
      <div class="grid4">
        <label>Test suite<select name="suite_id" ${caseId ? 'disabled title="Use Move to change the suite"' : ''}>${suiteOptions(ctx.suites, c.suite_id)}</select></label>
        <label>Priority<select name="priority">${options(m.priorities, c.priority)}</select></label>
        <label>Test type<select name="test_type">${options(m.test_types, c.test_type)}</select></label>
        <label>Status<select name="status">${options(m.case_statuses, c.status)}</select></label>
      </div>
      <div class="grid4">
        <label>Execution type<select name="execution_type">${options(m.execution_types, c.execution_type)}</select></label>
        <label>Requirement ID<input name="requirement_ref" value="${esc(c.requirement_ref)}" placeholder="BRD-001, FSD-2.3"></label>
        <label>Tags<input name="tags" value="${esc(c.tags)}" placeholder="smoke, regression"></label>
        <label>Est. minutes<input name="estimated_minutes" type="number" min="0" value="${esc(c.estimated_minutes)}"></label>
      </div>
      <label>Objective / description<textarea name="objective" rows="2">${esc(c.objective)}</textarea></label>
      <label>Preconditions<textarea name="preconditions" rows="2">${esc(c.preconditions)}</textarea></label>
      <h3>Test steps</h3>
      <table class="table steps-edit"><thead><tr><th class="num">#</th><th>Test step / action</th><th>Test data</th><th>Expected result</th><th></th></tr></thead>
        <tbody id="steps"></tbody></table>
      <button type="button" class="btn small" id="addStep">+ Add step</button>
      <label class="mt">Postconditions<textarea name="postconditions" rows="2">${esc(c.postconditions)}</textarea></label>
      <div class="form-error" id="caseError"></div>
    </form>`;

  const tbody = $('#steps');
  const addRow = (s = {}) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="num step-no"></td>
      <td><textarea data-f="action" rows="2">${esc(s.action)}</textarea></td>
      <td><textarea data-f="test_data" rows="2">${esc(s.test_data)}</textarea></td>
      <td><textarea data-f="expected_result" rows="2">${esc(s.expected_result)}</textarea></td>
      <td class="step-btns"><button type="button" class="icon-btn" data-m="up" title="Move up">↑</button><button type="button" class="icon-btn" data-m="down" title="Move down">↓</button><button type="button" class="icon-btn" data-m="del" title="Remove step">✕</button></td>`;
    tbody.append(tr);
    renumber();
    return tr;
  };
  const renumber = () => $$('tr', tbody).forEach((tr, i) => { $('.step-no', tr).textContent = i + 1; });
  (c.steps.length ? c.steps : [{}]).forEach(addRow);
  $('#addStep').onclick = () => $('textarea', addRow()).focus();
  tbody.onclick = (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const tr = b.closest('tr');
    if (b.dataset.m === 'up' && tr.previousElementSibling) tr.previousElementSibling.before(tr);
    if (b.dataset.m === 'down' && tr.nextElementSibling) tr.nextElementSibling.after(tr);
    if (b.dataset.m === 'del') tr.remove();
    renumber();
  };
  $('#cancel').onclick = () => go(specUrl(caseId ? `case=${caseId}` : `suite=${suiteId}`));

  const form = $('#caseForm');
  let another = false;
  $$('[type=submit]', form).forEach((b) => { b.onclick = () => { another = !!b.dataset.another; }; });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = formValues(form);
    body.steps = $$('tr', tbody).map((tr) => Object.fromEntries($$('textarea', tr).map((t) => [t.dataset.f, t.value])));
    if (!body.title.trim()) { $('#caseError').textContent = 'Title is required'; return; }
    try {
      if (caseId) {
        const r = await PUT(`/cases/${caseId}`, body);
        toast(r.changed ? 'Test case saved' : 'No changes');
        go(specUrl(`case=${caseId}`));
      } else {
        const r = await POST('/cases', body);
        toast('Test case created');
        await loadProjects();
        go(specUrl(another ? `new=${body.suite_id}&t=${Date.now()}` : `case=${r.id}`));
      }
    } catch (err) {
      $('#caseError').textContent = err.message;
    }
  };
}
