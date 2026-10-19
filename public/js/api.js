export const state = {
  user: null,
  meta: null,
  projects: [],
  projectId: Number(localStorage.getItem('tm.projectId')) || null,
};

export const project = () => state.projects.find((p) => p.id === state.projectId) || null;

export function setProject(id) {
  state.projectId = id ? Number(id) : null;
  try { localStorage.setItem('tm.projectId', state.projectId || ''); } catch { /* storage unavailable */ }
}

export const can = {
  edit: () => ['admin', 'tester'].includes(state.user?.role),
  approve: () => ['admin', 'client'].includes(state.user?.role),
  admin: () => state.user?.role === 'admin',
};

export async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${url}`, opts);
  const data = (res.headers.get('content-type') || '').includes('application/json') ? await res.json() : null;
  if (res.status === 401 && !url.startsWith('/auth/')) {
    state.user = null;
    location.hash = '#/login';
    throw new Error('Your session has expired. Please log in again.');
  }
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

export const GET = (url) => api('GET', url);
export const POST = (url, body) => api('POST', url, body ?? {});
export const PUT = (url, body) => api('PUT', url, body ?? {});
export const DEL = (url) => api('DELETE', url);

export async function loadProjects() {
  state.projects = await GET('/projects');
  if (!state.projects.some((p) => p.id === state.projectId)) setProject(state.projects[0]?.id || null);
  return state.projects;
}
