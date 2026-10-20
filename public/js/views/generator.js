import { state, GET, POST, project, can, loadProjects } from '../api.js';
import { esc, $, $$, toast, options, suiteOptions, fmtDateTime, fmtSize } from '../ui.js';
import { go } from '../app.js';

const COVERAGE = [
  ['positive', 'Positive / happy path'],
  ['negative', 'Negative & error handling'],
  ['boundary', 'Boundary values & validation'],
  ['security', 'Roles, permissions & security'],
  ['integration', 'End-to-end / integration'],
];
const COUNTS = [['auto', 'Let the AI decide'], ['5', 'About 5'], ['10', 'About 10'], ['20', 'About 20'], ['40', 'About 40']];

// Kept in memory (and sessionStorage) so drafts survive navigating away and back.
let gen = null;
const storeKey = () => `tm.aigen.${state.user?.id}.${state.projectId}`;
function freshState(suiteId) {
  return {
    projectId: state.projectId,
    form: { text: '', jira: '', target: suiteId ? String(suiteId) : '', newSuite: `AI generated ${new Date().toISOString().slice(0, 10)}`, language: 'en', count: 'auto', coverage: ['positive', 'negative', 'boundary'], group: true, instructions: '' },
    files: [],
    jiraPreview: [],
    result: null,
    createStatus: 'Draft',
    created: null,
  };
}
function save() {
  try {
    const { files, ...rest } = gen;
    sessionStorage.setItem(storeKey(), JSON.stringify(rest));
  } catch { /* storage full or unavailable */ }
}
function load(suiteId) {
  if (gen && gen.projectId === state.projectId) return;
  gen = freshState(suiteId);
  try {
    const saved = JSON.parse(sessionStorage.getItem(storeKey()) || 'null');
    if (saved) gen = { ...gen, ...saved, files: [] };
  } catch { /* ignore */ }
}

export async function renderGenerator(main, _, query) {
  const p = project();
  const suiteParam = Number(query.get('suite')) || null;
  load(suiteParam);
  if (suiteParam) gen.form.target = String(suiteParam);
  const [status, tree] = await Promise.all([GET('/ai/status'), GET(`/projects/${p.id}/tree`)]);
  gen.suites = tree.suites;

  main.innerHTML = `
    <div class="page wide">
      <div class="page-head">
        <div><div class="crumbs"><a href="#/spec">Test specification</a></div>
          <h1><span class="spark">✦</span> AI Test Case Generator</h1>
          <p class="muted">Paste requirements, attach BRD / FSD / TSD documents, or link Jira issues. Review the drafts, then create them as test cases.</p></div>
        <div class="actions">
          <span class="tag" title="Configured AI">${esc(status.provider === 'openai' ? 'Open-source model' : 'Claude')} · ${esc(status.model)}</span>
          ${can.admin() ? '<a class="btn small" href="#/settings">AI & Jira settings</a>' : ''}
        </div>
      </div>
      ${!can.edit() ? '<div class="callout warn">Only testers and admins can generate test cases.</div>' : ''}
      ${!status.ai_configured ? `<div class="callout warn">AI is not configured yet. ${can.admin() ? '<a href="#/settings">Open Settings</a> to add a Claude API key or connect an open-source model server.' : 'Ask an administrator to set it up under Settings.'}</div>` : ''}
      <div class="gen-layout">
        <form id="genForm" class="card pad gen-form">
          <h2>1. Requirements</h2>
          <label>Paste requirements <span class="hint">user stories, acceptance criteria, BRD/FSD/TSD sections</span>
            <textarea name="text" rows="9" placeholder="As a customer, I want to transfer money to another bank via BI-FAST so that...&#10;&#10;Acceptance criteria:&#10;1. Minimum amount Rp10.000, maximum Rp250.000.000 per transaction&#10;2. ...">${esc(gen.form.text)}</textarea></label>
          <div class="field-label">Attach documents <span class="hint">${esc(status.document_types)} · up to 10 files, 30 MB each</span></div>
          <div class="dropzone small" id="docDrop" tabindex="0">
            <input type="file" id="docInput" multiple hidden accept="${esc(status.document_types)}">
            <span>Drop files here or <button type="button" class="linklike" id="docBrowse">browse</button></span>
            <div id="docList" class="doc-list"></div>
          </div>
          <label>Jira issues <span class="hint">${status.jira_configured ? 'keys or URLs, e.g. PAY-142, PAY-150' : 'not configured'}</span>
            <div class="inline"><input name="jira" value="${esc(gen.form.jira)}" placeholder="PAY-142, https://yourcompany.atlassian.net/browse/PAY-150" ${status.jira_configured ? '' : 'disabled'}>
            <button type="button" class="btn small" id="jiraCheck" ${status.jira_configured ? '' : 'disabled'}>Check</button></div></label>
          <div id="jiraPreview"></div>

          <h2>2. Options</h2>
          <div class="grid2">
            <label>Create in suite<select name="target">${suiteOptions(gen.suites, gen.form.target, { rootLabel: '+ New suite…' })}</select></label>
            <label id="newSuiteWrap">New suite name<input name="newSuite" value="${esc(gen.form.newSuite)}"></label>
          </div>
          <div class="grid2">
            <label>Language<select name="language">${options([['en', 'English'], ['id', 'Bahasa Indonesia']], gen.form.language)}</select></label>
            <label>Number of test cases<select name="count">${options(COUNTS, gen.form.count)}</select></label>
          </div>
          <fieldset><legend>Coverage</legend>
            <div class="check-grid">${COVERAGE.map(([v, l]) => `<label class="check"><input type="checkbox" name="coverage" value="${v}" ${gen.form.coverage.includes(v) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
          </fieldset>
          <label class="check"><input type="checkbox" name="group" ${gen.form.group ? 'checked' : ''}> Group into sub-suites by feature</label>
          <label>Additional instructions <span class="hint">optional</span>
            <textarea name="instructions" rows="2" placeholder="e.g. Users are bank tellers. Use Indonesian Rupiah format. Skip performance tests.">${esc(gen.form.instructions)}</textarea></label>
          <div class="form-error" id="genError"></div>
          <div class="actions">
            <button class="btn primary" id="genBtn" ${!can.edit() || !status.ai_configured ? 'disabled' : ''}>✦ Generate test cases</button>
            <button type="button" class="btn" id="genCancel" hidden>Cancel</button>
            <span class="muted small" id="genTimer"></span>
          </div>
          <p class="muted small">The AI sees only what you provide here. Review every draft before creating it.</p>
        </form>
        <section id="review" class="gen-review"></section>
      </div>
      <details class="history-box" id="historyBox"><summary>Recent generations</summary><div id="historyList" class="muted small">Loading…</div></details>
    </div>`;

  const form = $('#genForm');
  wireForm(form, status);
  drawDocs();
  drawJira();
  drawReview();
  $('#historyBox').addEventListener('toggle', async (e) => {
    if (!e.target.open) return;
    const rows = await GET(`/projects/${p.id}/ai/history`);
    $('#historyList').innerHTML = rows.length ? `<table class="table small"><thead><tr><th>When</th><th>By</th><th>Model</th><th>Sources</th><th class="num">Drafts</th><th class="num">Created</th><th class="num">Tokens in/out</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="nowrap">${fmtDateTime(r.created_at)}</td><td>${esc(r.user_name || '-')}</td><td>${esc(r.model)}</td>
        <td>${r.sources.map((s) => (s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name))).join(', ')}</td>
        <td class="num">${r.case_count}</td><td class="num">${r.created_count}</td><td class="num">${r.input_tokens ?? '-'} / ${r.output_tokens ?? '-'}</td></tr>`).join('')}
      </tbody></table>` : 'No generations yet.';
  });
}

/* ------------------------------------------------------------------ form */

function readForm(form) {
  gen.form = {
    text: form.text.value,
    jira: form.jira.value,
    target: form.target.value,
    newSuite: form.newSuite.value,
    language: form.language.value,
    count: form.count.value,
    coverage: $$('input[name=coverage]:checked', form).map((c) => c.value),
    group: form.group.checked,
    instructions: form.instructions.value,
  };
  save();
}

function wireForm(form, status) {
  const toggleNewSuite = () => { $('#newSuiteWrap').hidden = Boolean(form.target.value); };
  toggleNewSuite();
  form.addEventListener('input', () => readForm(form));
  form.addEventListener('change', () => { readForm(form); toggleNewSuite(); });

  const addFiles = (list) => {
    for (const f of list) {
      if (gen.files.length >= 10) { toast('Attach at most 10 documents', 'error'); break; }
      if (f.size > 30 * 1024 * 1024) { toast(`${f.name} is larger than 30 MB`, 'error'); continue; }
      if (!gen.files.some((x) => x.name === f.name && x.size === f.size)) gen.files.push(f);
    }
    drawDocs();
  };
  $('#docBrowse').onclick = () => $('#docInput').click();
  $('#docInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  const dz = $('#docDrop');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); addFiles(e.dataTransfer.files); });
  $('#docList').onclick = (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { gen.files.splice(Number(rm.dataset.rm), 1); drawDocs(); }
  };

  $('#jiraCheck').onclick = async () => {
    if (!form.jira.value.trim()) return;
    $('#jiraPreview').innerHTML = '<p class="muted small">Checking Jira…</p>';
    try {
      gen.jiraPreview = await GET(`/jira/issues?keys=${encodeURIComponent(form.jira.value)}`);
    } catch (e) {
      gen.jiraPreview = [{ key: '', error: e.message }];
    }
    save();
    drawJira();
  };

  let controller = null;
  $('#genCancel').onclick = () => controller?.abort();
  form.onsubmit = async (e) => {
    e.preventDefault();
    readForm(form);
    const err = $('#genError');
    err.textContent = '';
    if (!gen.form.text.trim() && !gen.files.length && !gen.form.jira.trim()) {
      err.textContent = 'Add requirements: paste text, attach a document, or enter a Jira issue.';
      return;
    }
    if (gen.result && !gen.created && gen.result.cases.length
      && !window.confirm('Generating again replaces the current drafts that have not been created yet. Continue?')) return;
    const fd = new FormData();
    fd.append('data', JSON.stringify({
      text: gen.form.text, jira: gen.form.jira, language: gen.form.language, count: gen.form.count,
      coverage: gen.form.coverage, group: gen.form.group, instructions: gen.form.instructions,
      target_suite_id: Number(gen.form.target) || null,
    }));
    gen.files.forEach((f) => fd.append('documents', f, f.name));

    const btn = $('#genBtn');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    $('#genCancel').hidden = false;
    const started = Date.now();
    const timer = setInterval(() => { $('#genTimer').textContent = `${Math.round((Date.now() - started) / 1000)}s — large documents can take a few minutes`; }, 1000);
    controller = new AbortController();
    try {
      const res = await fetch(`/api/projects/${state.projectId}/ai/generate`, { method: 'POST', body: fd, signal: controller.signal });
      const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
      if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
      gen.result = { ...data, cases: data.cases.map((c) => ({ ...c, selected: true })) };
      gen.created = null;
      save();
      drawReview();
      toast(`${data.cases.length} draft test cases generated`);
      $('#review').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (ex) {
      err.textContent = ex.name === 'AbortError' ? 'Cancelled.' : ex.message;
    } finally {
      clearInterval(timer);
      $('#genTimer').textContent = '';
      btn.disabled = false;
      btn.textContent = '✦ Generate test cases';
      $('#genCancel').hidden = true;
      controller = null;
    }
  };
}

function drawDocs() {
  $('#docList').innerHTML = gen.files.map((f, i) => `<span class="chip">${esc(f.name)} <small>${fmtSize(f.size)}</small>
    <button type="button" class="icon-btn" data-rm="${i}" title="Remove">✕</button></span>`).join('');
}

function drawJira() {
  $('#jiraPreview').innerHTML = gen.jiraPreview.length ? `<ul class="jira-list">${gen.jiraPreview.map((j) => (j.error
    ? `<li class="t-failed">${esc(j.key)} ${esc(j.error)}</li>`
    : `<li><a href="${esc(j.url)}" target="_blank" rel="noopener"><b>${esc(j.key)}</b></a> ${esc(j.summary)} <span class="tag">${esc(j.type)}</span> <span class="tag">${esc(j.status)}</span></li>`)).join('')}</ul>` : '';
}

/* ------------------------------------------------------------------ review */

const PRIORITIES = () => state.meta.priorities;
const TYPES = () => state.meta.test_types;

function drawReview() {
  const box = $('#review');
  const r = gen.result;
  if (!r) {
    box.innerHTML = `<div class="empty gen-empty"><p><b>Drafts appear here.</b></p>
      <p>You review and edit each test case, then create the ones you want in Test Specification. Nothing is saved until you click <b>Create</b>.</p>
      <p class="small">Prefer Excel? Download the drafts as a spreadsheet in the same layout as Import / Export.</p></div>`;
    return;
  }
  const selected = r.cases.filter((c) => c.selected).length;
  const targetName = gen.form.target ? gen.suites.find((s) => s.id === Number(gen.form.target))?.name : gen.form.newSuite;
  box.innerHTML = `
    <div class="card pad">
      <div class="review-head">
        <div><h2>${r.cases.length} draft test case${r.cases.length === 1 ? '' : 's'}</h2>
          <p>${esc(r.summary)}</p>
          <p class="muted small">${esc(r.model)}${r.usage?.input_tokens ? ` · ${r.usage.input_tokens.toLocaleString()} tokens in / ${r.usage.output_tokens?.toLocaleString() ?? '-'} out` : ''} ·
            Sources: ${r.sources.map((s) => (s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name))).join(', ')}</p></div>
      </div>
      ${r.open_questions.length ? `<div class="callout warn"><b>Open questions for the business analyst</b>
        <ul>${r.open_questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>
        <button type="button" class="btn small" id="copyQuestions">Copy questions</button></div>` : ''}
      ${gen.created ? `<div class="callout ok"><b>${gen.created.count} test case(s) created</b> in “${esc(gen.created.suiteName)}” with status ${esc(gen.created.status)} and tag <code>ai-generated</code>.
        <a href="#/spec?suite=${gen.created.suite_id}">Open in Test Specification →</a></div>` : ''}
      <div class="review-toolbar">
        <label class="check"><input type="checkbox" id="selAll" ${selected === r.cases.length ? 'checked' : ''}> Select all</label>
        <button type="button" class="btn small" id="expandAll">Expand all</button>
        <span class="spacer"></span>
        <button type="button" class="btn small" data-export="xlsx">Download Excel</button>
        <button type="button" class="btn small" data-export="csv">CSV</button>
        <button type="button" class="btn small danger-text" id="discard">Discard</button>
      </div>
      <div id="drafts">${r.cases.map(draftCard).join('')}</div>
      <div class="review-footer">
        <label>Status for new test cases<select id="createStatus">${options([['Draft', 'Draft — review before use'], ['Ready', 'Ready']], gen.createStatus)}</select></label>
        <div class="muted small">Target: <b>${esc(targetName || '-')}</b>${gen.form.target ? '' : ' (new suite)'}${gen.form.group ? ', grouped into sub-suites by feature' : ''}</div>
        <button type="button" class="btn primary" id="createBtn" ${!selected || !can.edit() ? 'disabled' : ''}>Create ${selected} test case${selected === 1 ? '' : 's'}</button>
      </div>
    </div>`;
  wireReview(box);
}

function draftCard(c, i) {
  return `<div class="draft ${c.selected ? '' : 'off'}" data-i="${i}">
    <div class="draft-head">
      <input type="checkbox" data-sel ${c.selected ? 'checked' : ''} aria-label="Include draft ${i + 1}">
      <span class="draft-no">${i + 1}</span>
      ${c.suite ? `<span class="chip suite-chip"><span class="ico folder"></span> ${esc(c.suite)}</span>` : ''}
      <input class="draft-title" data-f="title" value="${esc(c.title)}" aria-label="Title">
      <select data-f="priority" aria-label="Priority">${options(PRIORITIES(), c.priority)}</select>
      <span class="muted small nowrap">${c.steps.length} step${c.steps.length === 1 ? '' : 's'}</span>
      <button type="button" class="icon-btn" data-toggle title="Show details">${c.open ? '▾' : '▸'}</button>
    </div>
    ${c.open ? `<div class="draft-body">
      <div class="grid4">
        <label>Suite / feature<input data-f="suite" value="${esc(c.suite)}" placeholder="(target suite)"></label>
        <label>Test type<select data-f="test_type">${options(TYPES(), c.test_type)}</select></label>
        <label>Requirement ID<input data-f="requirement_ref" value="${esc(c.requirement_ref)}"></label>
        <label>Tags<input data-f="tags" value="${esc(c.tags)}"></label>
      </div>
      <div class="grid2">
        <label>Objective<textarea data-f="objective" rows="2">${esc(c.objective)}</textarea></label>
        <label>Preconditions<textarea data-f="preconditions" rows="2">${esc(c.preconditions)}</textarea></label>
      </div>
      <table class="table steps-edit"><thead><tr><th class="num">#</th><th>Test step</th><th>Test data</th><th>Expected result</th><th></th></tr></thead>
        <tbody>${c.steps.map((s, j) => `<tr data-j="${j}"><td class="num">${j + 1}</td>
          <td><textarea data-s="action" rows="2">${esc(s.action)}</textarea></td>
          <td><textarea data-s="test_data" rows="2">${esc(s.test_data)}</textarea></td>
          <td><textarea data-s="expected_result" rows="2">${esc(s.expected_result)}</textarea></td>
          <td><button type="button" class="icon-btn" data-rmstep title="Remove step">✕</button></td></tr>`).join('')}</tbody></table>
      <div class="actions"><button type="button" class="btn small" data-addstep>+ Add step</button>
        <span class="spacer"></span><button type="button" class="btn small danger-text" data-remove>Remove draft</button></div>
    </div>` : ''}
  </div>`;
}

function wireReview(box) {
  const r = gen.result;
  const redrawCard = (i) => {
    const el = $(`.draft[data-i="${i}"]`, box);
    el.outerHTML = draftCard(r.cases[i], i);
  };
  const refreshCounts = () => {
    const n = r.cases.filter((c) => c.selected).length;
    const btn = $('#createBtn');
    btn.textContent = `Create ${n} test case${n === 1 ? '' : 's'}`;
    btn.disabled = !n || !can.edit();
    $('#selAll').checked = n === r.cases.length;
  };

  $('#drafts', box).addEventListener('input', (e) => {
    const card = e.target.closest('.draft');
    if (!card) return;
    const c = r.cases[Number(card.dataset.i)];
    if (e.target.dataset.f) c[e.target.dataset.f] = e.target.value;
    if (e.target.dataset.s) c.steps[Number(e.target.closest('tr').dataset.j)][e.target.dataset.s] = e.target.value;
    save();
  });
  $('#drafts', box).addEventListener('change', (e) => {
    const card = e.target.closest('.draft');
    if (!card || e.target.dataset.sel === undefined) return;
    const c = r.cases[Number(card.dataset.i)];
    c.selected = e.target.checked;
    card.classList.toggle('off', !c.selected);
    save();
    refreshCounts();
  });
  $('#drafts', box).addEventListener('click', (e) => {
    const card = e.target.closest('.draft');
    if (!card) return;
    const i = Number(card.dataset.i);
    const c = r.cases[i];
    if (e.target.closest('[data-toggle]')) { c.open = !c.open; redrawCard(i); }
    else if (e.target.closest('[data-addstep]')) { c.steps.push({ action: '', test_data: '', expected_result: '' }); redrawCard(i); }
    else if (e.target.closest('[data-rmstep]')) { c.steps.splice(Number(e.target.closest('tr').dataset.j), 1); redrawCard(i); }
    else if (e.target.closest('[data-remove]')) { r.cases.splice(i, 1); drawReview(); }
    else return;
    save();
  });

  $('#selAll').onchange = (e) => { r.cases.forEach((c) => { c.selected = e.target.checked; }); save(); drawReview(); };
  $('#expandAll').onclick = () => { const open = !r.cases.every((c) => c.open); r.cases.forEach((c) => { c.open = open; }); save(); drawReview(); };
  $('#discard').onclick = () => {
    if (!window.confirm('Discard all drafts?')) return;
    gen.result = null;
    gen.created = null;
    save();
    drawReview();
  };
  $('#copyQuestions')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(r.open_questions.map((q, i) => `${i + 1}. ${q}`).join('\n'));
      toast('Questions copied');
    } catch { toast('Copy failed — select the text manually', 'error'); }
  });
  $('#createStatus').onchange = (e) => { gen.createStatus = e.target.value; save(); };

  $$('[data-export]', box).forEach((b) => {
    b.onclick = async () => {
      const cases = r.cases.filter((c) => c.selected);
      if (!cases.length) { toast('Select at least one draft', 'error'); return; }
      try {
        const res = await fetch(`/api/projects/${state.projectId}/ai/export`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cases, format: b.dataset.export }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        const url = URL.createObjectURL(await res.blob());
        const a = Object.assign(document.createElement('a'), { href: url, download: `${project().prefix}-ai-test-cases.${b.dataset.export}` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) { toast(e.message, 'error'); }
    };
  });

  $('#createBtn').onclick = async () => {
    const cases = r.cases.filter((c) => c.selected);
    const empties = cases.filter((c) => !c.title.trim());
    if (empties.length) { toast('Every selected draft needs a title', 'error'); return; }
    if (!gen.form.target && !gen.form.newSuite.trim()) { toast('Enter a name for the new suite', 'error'); return; }
    if (gen.created && !window.confirm('These drafts were already created once. Create them again as additional copies?')) return;
    const btn = $('#createBtn');
    btn.disabled = true;
    try {
      const out = await POST(`/projects/${state.projectId}/ai/create`, {
        generation_id: r.generation_id,
        target_suite_id: Number(gen.form.target) || null,
        new_suite_name: gen.form.newSuite,
        status: gen.createStatus,
        cases: cases.map(({ selected, open, ...c }) => c),
      });
      const suiteName = gen.form.target ? gen.suites.find((s) => s.id === Number(gen.form.target))?.name : gen.form.newSuite;
      gen.created = { count: out.created.length, suite_id: out.suite_id, suiteName, status: gen.createStatus };
      if (!gen.form.target) gen.form.target = String(out.suite_id); // further creates go to the same suite
      save();
      toast(`${out.created.length} test case(s) created`);
      await loadProjects();
      go(`generate?t=${Date.now()}`);
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
    }
  };
}
