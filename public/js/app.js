import { state, GET, POST, PUT, loadProjects, setProject, project, can } from './api.js';
import { esc, $, $$, modal, toast, formValues } from './ui.js';
import { renderDashboard, renderProjects, renderUsers, renderImportExport, renderReports } from './views/misc.js';
import { renderSpec } from './views/spec.js';
import { renderPlans, renderPlan } from './views/plans.js';
import { renderGenerator } from './views/generator.js';
import { renderSettings } from './views/settings.js';
import { tokenManager } from './views/tokens.js';

const NAV = [
  ['dashboard', 'Dashboard'],
  ['spec', 'Test Specification'],
  ['plans', 'Test Plans & Execution'],
  ['import', 'Import / Export'],
  ['reports', 'Reports'],
];

const ROUTES = [
  [/^$|^dashboard$/, renderDashboard, true],
  [/^projects$/, renderProjects, false],
  [/^spec$/, renderSpec, true],
  [/^plans$/, renderPlans, true],
  [/^plans\/(\d+)$/, renderPlan, false],
  [/^import$/, renderImportExport, true],
  [/^reports$/, renderReports, true],
  [/^users$/, renderUsers, false],
  [/^generate$/, renderGenerator, true],
  [/^settings$/, renderSettings, false],
];

// Pages without their own nav item highlight the closest one.
const NAV_PARENT = { generate: 'spec' };

export function go(path) {
  location.hash = `#/${path}`;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { path, query: new URLSearchParams(qs || '') };
}

function renderLogin() {
  document.body.className = 'login-page';
  $('#app').innerHTML = `
    <form class="login-card" id="loginForm">
      <div class="brand big"><span class="logo">✓</span> TestDesk</div>
      <p class="muted">Test case management, SIT/UAT execution and sign-off</p>
      <label>Username<input name="username" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <div class="form-error" id="loginError"></div>
      <button class="btn primary block">Log in</button>
    </form>`;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      state.user = await POST('/auth/login', formValues(e.target));
      await boot();
      go('dashboard');
    } catch (err) {
      $('#loginError').textContent = err.message;
    }
  };
  $('#loginForm input').focus();
}

function renderShell() {
  document.body.className = '';
  const navLinks = [...NAV, ...(can.admin() ? [['users', 'Users'], ['settings', 'Settings']] : [])];
  $('#app').innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/dashboard"><span class="logo">✓</span> TestDesk</a>
      <div class="project-switch">
        <select id="projectSelect" aria-label="Project"></select>
        <a href="#/projects" class="icon-btn" title="Manage projects">⚙</a>
      </div>
      <nav id="nav">${navLinks.map(([p, l]) => `<a href="#/${p}" data-nav="${p}">${esc(l)}</a>`).join('')}</nav>
      <div class="user-menu">
        <button class="btn ghost" id="userBtn">${esc(state.user.full_name)} <span class="role">${esc(state.user.role)}</span> ▾</button>
        <div class="dropdown" id="userDropdown" hidden>
          ${can.edit() ? '<button data-act="tokens">API tokens (CI / automation)</button>' : ''}
          <button data-act="password">Change password</button>
          <button data-act="logout">Log out</button>
        </div>
      </div>
    </header>
    <main id="main"></main>`;
  fillProjectSelect();
  $('#projectSelect').onchange = (e) => {
    setProject(e.target.value);
    const { path } = parseHash();
    go(/^plans\/\d+/.test(path) ? 'plans' : path || 'dashboard');
    route();
  };
  $('#userBtn').onclick = (e) => {
    e.stopPropagation();
    $('#userDropdown').hidden = !$('#userDropdown').hidden;
  };
  document.addEventListener('click', () => { const d = $('#userDropdown'); if (d) d.hidden = true; });
  $('#userDropdown').onclick = async (e) => {
    const act = e.target.dataset.act;
    if (act === 'logout') {
      await POST('/auth/logout');
      state.user = null;
      go('login');
    } else if (act === 'password') changePassword();
    else if (act === 'tokens') tokenManager();
  };
}

export function fillProjectSelect() {
  const sel = $('#projectSelect');
  if (!sel) return;
  sel.innerHTML = state.projects.length
    ? state.projects.map((p) => `<option value="${p.id}" ${p.id === state.projectId ? 'selected' : ''}>${esc(p.prefix)} — ${esc(p.name)}</option>`).join('')
    : '<option value="">No project yet</option>';
}

function changePassword() {
  modal({
    title: 'Change password',
    body: `<label>Current password<input type="password" name="current_password" required></label>
           <label>New password<input type="password" name="new_password" minlength="6" required></label>`,
    onSubmit: async (form) => {
      await PUT('/auth/password', formValues(form));
      toast('Password changed');
    },
  });
}

async function route() {
  const { path, query } = parseHash();
  if (!state.user) return renderLogin();
  if (path === 'login') return go('dashboard');
  if (!$('#main')) renderShell();
  const navPath = NAV_PARENT[path] || path;
  $$('#nav a').forEach((a) => a.classList.toggle('active', navPath === a.dataset.nav || navPath.startsWith(`${a.dataset.nav}/`) || (!navPath && a.dataset.nav === 'dashboard')));
  const main = $('#main');
  const hit = ROUTES.find(([re]) => re.test(path));
  if (!hit) {
    main.innerHTML = '<div class="page"><h2>Page not found</h2></div>';
    return;
  }
  const [re, view, needsProject] = hit;
  if (needsProject && !project()) {
    main.innerHTML = `<div class="page"><div class="empty"><h2>No project selected</h2>
      <p>${can.admin() ? 'Create a project to start writing test cases.' : 'Ask an administrator to create a project.'}</p>
      <a class="btn primary" href="#/projects">Go to projects</a></div></div>`;
    return;
  }
  main.innerHTML = '<div class="loading">Loading…</div>';
  try {
    await view(main, path.match(re).slice(1), query);
  } catch (err) {
    if (state.user) main.innerHTML = `<div class="page"><div class="empty error"><h2>Something went wrong</h2><p>${esc(err.message)}</p></div></div>`;
  }
}

/** Re-render the current route (views call this after changes). */
export const refresh = () => route();

async function boot() {
  state.meta = await GET('/meta');
  await loadProjects();
  renderShell();
}

window.addEventListener('hashchange', route);

(async () => {
  try {
    state.user = await GET('/auth/me');
    await boot();
  } catch {
    state.user = null;
  }
  route();
})();
