// Small DOM helpers shared by all views.

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const nl2br = (v) => esc(v).replace(/\n/g, '<br>');
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const STATUS_CLASS = {
  Passed: 'passed', Failed: 'failed', Blocked: 'blocked', Skipped: 'skipped', 'Not Run': 'notrun',
  Approved: 'passed', Rejected: 'failed', Pending: 'pending', 'Approved with notes': 'pending',
  Draft: 'notrun', Ready: 'info', Obsolete: 'skipped', Active: 'info', Closed: 'skipped',
  SIT: 'sit', UAT: 'uat', Critical: 'failed', High: 'blocked', Medium: 'info', Low: 'skipped',
};

export const badge = (text, kind = text) => `<span class="badge ${STATUS_CLASS[kind] || ''}">${esc(text)}</span>`;

/** SQLite timestamps are UTC "YYYY-MM-DD HH:MM:SS". */
export function fmtDateTime(s) {
  if (!s) return '-';
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
export function fmtDate(s) {
  if (!s) return '-';
  return new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
export const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function toast(message, type = 'ok') {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

/**
 * Opens a modal form. onSubmit(form) may throw to show an error, or return false to keep it open.
 */
export function modal({ title, body, submitLabel = 'Save', cancelLabel = 'Cancel', wide = false, danger = false, hideSubmit = false, onSubmit, onOpen, onClose }) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <form class="modal ${wide ? 'wide' : ''}" novalidate>
      <header><h3>${esc(title)}</h3><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
      <div class="modal-body">${body}</div>
      <footer>
        <span class="modal-error"></span>
        <button type="button" class="btn" data-close>${esc(cancelLabel)}</button>
        ${hideSubmit ? '' : `<button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${esc(submitLabel)}</button>`}
      </footer>
    </form>`;
  document.body.append(wrap);
  const form = $('form', wrap);
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $$('[data-close]', wrap).forEach((b) => { b.onclick = close; });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('[type=submit]', form);
    const err = $('.modal-error', form);
    err.textContent = '';
    for (const el of $$('[required]', form)) {
      if (!String(el.value).trim()) {
        err.textContent = `${el.closest('label')?.firstChild?.textContent?.trim() || 'A field'} is required`;
        el.focus();
        return;
      }
    }
    if (btn) btn.disabled = true;
    try {
      const keepOpen = (await onSubmit?.(form)) === false;
      if (!keepOpen) close();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  onOpen?.(form, close);
  setTimeout(() => $('input:not([type=hidden]),select,textarea', form)?.focus());
  return { form, close };
}

export function confirmBox(message, { title = 'Please confirm', okLabel = 'OK', danger = true } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    modal({
      title, body: `<p>${nl2br(message)}</p>`, submitLabel: okLabel, danger,
      onSubmit: () => { ok = true; },
      onClose: () => resolve(ok),
    });
  });
}

export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') {
      if (el.dataset.multi !== undefined) {
        out[el.name] ||= [];
        if (el.checked) out[el.name].push(el.value);
      } else out[el.name] = el.checked;
    } else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else out[el.name] = el.value;
  }
  return out;
}

export const options = (list, selected) => list.map((v) => {
  const [value, label] = Array.isArray(v) ? v : [v, v];
  return `<option value="${esc(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
}).join('');

/** Suite list -> nested structure helpers. */
export function suiteTree(suites) {
  const children = new Map();
  for (const s of suites) {
    const k = s.parent_id || 0;
    if (!children.has(k)) children.set(k, []);
    children.get(k).push(s);
  }
  for (const list of children.values()) list.sort((a, b) => a.sort - b.sort || a.id - b.id);
  return children;
}

export function suiteOptions(suites, selected, { exclude = null, rootLabel = null } = {}) {
  const children = suiteTree(suites);
  const excluded = new Set();
  if (exclude) {
    const walk = (id) => { excluded.add(id); (children.get(id) || []).forEach((c) => walk(c.id)); };
    walk(exclude);
  }
  let html = rootLabel !== null ? `<option value="">${esc(rootLabel)}</option>` : '';
  const walk = (parent, depth) => {
    for (const s of children.get(parent) || []) {
      if (excluded.has(s.id)) continue;
      html += `<option value="${s.id}" ${s.id === Number(selected) ? 'selected' : ''}>${'   '.repeat(depth)}${depth ? '└ ' : ''}${esc(s.name)}</option>`;
      walk(s.id, depth + 1);
    }
  };
  walk(0, 0);
  return html;
}

export function suitePathOf(suites, id) {
  const byId = new Map(suites.map((s) => [s.id, s]));
  const parts = [];
  for (let s = byId.get(id); s; s = byId.get(s.parent_id)) parts.unshift(s.name);
  return parts.join(' / ');
}

export function progressBar(s) {
  if (!s.total) return '<div class="bar"></div>';
  const seg = (k, cls) => (s[k] ? `<span class="${cls}" style="width:${(s[k] / s.total) * 100}%" title="${k}: ${s[k]}"></span>` : '');
  return `<div class="bar">${seg('Passed', 'passed')}${seg('Failed', 'failed')}${seg('Blocked', 'blocked')}${seg('Skipped', 'skipped')}</div>`;
}

export function statChips(s) {
  return `<div class="chips">
    <span class="chip">Total <b>${s.total}</b></span>
    <span class="chip passed">Passed <b>${s.Passed}</b></span>
    <span class="chip failed">Failed <b>${s.Failed}</b></span>
    <span class="chip blocked">Blocked <b>${s.Blocked}</b></span>
    <span class="chip skipped">Skipped <b>${s.Skipped}</b></span>
    <span class="chip notrun">Not run <b>${s['Not Run']}</b></span>
    <span class="chip">Progress <b>${s.progress}%</b></span>
    <span class="chip">Pass rate <b>${s.pass_rate}%</b></span>
  </div>`;
}

export const empty = (text, action = '') => `<div class="empty"><p>${esc(text)}</p>${action}</div>`;
