import { state, GET, POST, DEL, can } from '../api.js';
import { esc, $, $$, modal, toast, options, fmtDateTime } from '../ui.js';

/** Create and revoke the API tokens used by CI pipelines (see docs/AUTOMATION.md). */
export async function tokenManager() {
  const users = can.admin() ? (await GET('/users')).filter((u) => u.active && u.role !== 'client') : [];
  let created = null;
  const m = modal({
    title: 'API tokens',
    wide: true,
    hideSubmit: true,
    cancelLabel: 'Close',
    body: '<div id="tokBox"></div>',
  });
  const box = () => $('#tokBox', m.form);

  const createdHtml = () => {
    if (!created) return '';
    const curl = `curl -H "Authorization: Bearer ${created.token}" \\\n  -F report=@junit.xml -F plan_name="Nightly regression" -F build=123 \\\n  ${location.origin}/api/projects/<PROJECT-PREFIX>/automation/junit`;
    return `<div class="callout ok"><b>Token created. Copy it now; it will not be shown again.</b>
      <div class="inline"><input id="newTok" readonly value="${esc(created.token)}"><button type="button" class="btn small" id="copyTok">Copy</button></div>
      <p class="small muted">Example (upload a JUnit report):</p><pre class="code">${esc(curl)}</pre></div>`;
  };

  const rowHtml = (t) => `<tr><td>${esc(t.name)}</td>${can.admin() ? `<td>${esc(t.user_name)}</td>` : ''}
    <td><code>${esc(t.prefix)}…</code></td><td class="nowrap">${fmtDateTime(t.created_at)}</td>
    <td class="nowrap">${t.last_used_at ? fmtDateTime(t.last_used_at) : 'never'}</td>
    <td class="nowrap">${t.expires_at ? fmtDateTime(t.expires_at.replace('T', ' ').slice(0, 19)) : 'never'}</td>
    <td class="row-actions"><button type="button" class="btn small danger-text" data-revoke="${t.id}">Revoke</button></td></tr>`;

  const draw = async () => {
    const tokens = await GET('/tokens');
    const ownerOptions = options(users.map((u) => [u.id, `${u.full_name} (${u.role})`]), state.user.id);
    box().innerHTML = `
      <p class="muted small">Tokens let a CI pipeline or script create test cases and report results through the automation API, with the permissions of the token owner.
        A token can <b>only</b> reach the automation endpoints. Treat it like a password.</p>
      ${createdHtml()}
      ${tokens.length ? `<table class="table small"><thead><tr><th>Name</th>${can.admin() ? '<th>Owner</th>' : ''}<th>Token</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr></thead>
        <tbody>${tokens.map(rowHtml).join('')}</tbody></table>` : '<p class="muted">No tokens yet.</p>'}
      <h3>New token</h3>
      <div class="grid3">
        <label>Name<input id="tokName" placeholder="GitHub Actions"></label>
        <label>Expires<select id="tokExp">${options([['', 'Never'], ['30', 'In 30 days'], ['90', 'In 90 days'], ['365', 'In 1 year']], '90')}</select></label>
        ${can.admin() ? `<label>Owner<select id="tokOwner">${ownerOptions}</select></label>` : '<span></span>'}
      </div>
      <div class="actions"><button type="button" class="btn primary" id="tokCreate">Create token</button><span class="form-error" id="tokErr"></span></div>`;

    $('#copyTok', m.form)?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(created.token);
        toast('Token copied');
      } catch {
        $('#newTok', m.form).select();
      }
    });
    $$('[data-revoke]', m.form).forEach((b) => {
      b.onclick = async () => {
        if (!window.confirm('Revoke this token? Pipelines using it stop working immediately.')) return;
        await DEL(`/tokens/${b.dataset.revoke}`);
        created = null;
        draw();
      };
    });
    $('#tokCreate', m.form).onclick = async () => {
      $('#tokErr', m.form).textContent = '';
      try {
        created = await POST('/tokens', {
          name: $('#tokName', m.form).value,
          expires_days: $('#tokExp', m.form).value || null,
          user_id: $('#tokOwner', m.form)?.value || null,
        });
        draw();
      } catch (e) {
        $('#tokErr', m.form).textContent = e.message;
      }
    };
  };
  await draw();
}
