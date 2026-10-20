import { HttpError } from '../db.js';

const KEY_RE = /\b([A-Z][A-Z0-9_]{1,19}-\d{1,9})\b/;

/** Accepts "ABC-123", "abc-123" or a Jira URL (…/browse/ABC-123, …?selectedIssue=ABC-123). */
export function parseIssueKeys(input) {
  const keys = [];
  for (const part of String(input || '').split(/[\s,;]+/)) {
    const m = part.toUpperCase().match(KEY_RE);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

function authHeader(settings) {
  if (!settings.jira_token) return null;
  // Jira Cloud: email + API token (Basic). Jira Server/Data Center: personal access token (Bearer).
  return settings.jira_email
    ? `Basic ${Buffer.from(`${settings.jira_email}:${settings.jira_token}`).toString('base64')}`
    : `Bearer ${settings.jira_token}`;
}

async function jiraGet(settings, apiPath) {
  if (!settings.jira_base_url) throw new HttpError(400, 'Jira is not configured. An admin can add the Jira URL and token under Settings → Jira.');
  const headers = { Accept: 'application/json' };
  const auth = authHeader(settings);
  if (auth) headers.Authorization = auth;
  let res;
  try {
    res = await fetch(`${settings.jira_base_url}${apiPath}`, { headers, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new HttpError(502, `Could not reach Jira at ${settings.jira_base_url} (${e.cause?.code || e.message}).`);
  }
  if (res.status === 401) throw new HttpError(400, 'Jira rejected the credentials. Check Settings → Jira.');
  if (res.status === 403) throw new HttpError(400, 'The Jira account has no permission for this request.');
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, `Jira error ${res.status}`);
  return res.json();
}

export async function testJira(settings) {
  const me = await jiraGet(settings, '/rest/api/2/myself');
  if (!me) throw new HttpError(400, 'Jira URL looks wrong (no /rest/api/2/myself).');
  return { name: me.displayName || me.name || me.emailAddress || 'unknown' };
}

/** Converts Atlassian Document Format (API v3 / some custom fields) to plain text. */
function adfToText(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return node.text || '';
  const inner = (node.content || []).map(adfToText).join('');
  switch (node.type) {
    case 'paragraph': case 'heading': return `${inner}\n`;
    case 'listItem': return `- ${inner.trim()}\n`;
    case 'hardBreak': return '\n';
    case 'tableRow': return `${(node.content || []).map((c) => adfToText(c).trim()).join(' | ')}\n`;
    default: return inner;
  }
}

const fieldText = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(', ');
  if (v.type === 'doc') return adfToText(v).trim();
  return v.value || v.name || v.displayName || '';
};

/** Fetches a Jira issue and renders the parts that matter for test design as text. */
export async function fetchIssue(settings, key) {
  const issue = await jiraGet(settings, `/rest/api/2/issue/${encodeURIComponent(key)}?expand=names&fields=*all`);
  if (!issue) throw new HttpError(404, `Jira issue ${key} not found, or the account cannot see it.`);
  const f = issue.fields || {};
  const names = issue.names || {};
  const lines = [
    `Jira issue: ${issue.key}`,
    `Summary: ${f.summary || ''}`,
    f.issuetype ? `Type: ${f.issuetype.name}` : '',
    f.priority ? `Priority: ${f.priority.name}` : '',
    f.status ? `Status: ${f.status.name}` : '',
    f.labels?.length ? `Labels: ${f.labels.join(', ')}` : '',
    f.components?.length ? `Components: ${fieldText(f.components)}` : '',
    f.fixVersions?.length ? `Fix versions: ${fieldText(f.fixVersions)}` : '',
    f.parent ? `Parent: ${f.parent.key} ${f.parent.fields?.summary || ''}` : '',
  ].filter(Boolean);
  const description = fieldText(f.description);
  if (description) lines.push('', 'Description:', description);
  // Teams keep acceptance criteria in custom fields with varying names.
  for (const [id, label] of Object.entries(names)) {
    if (!id.startsWith('customfield_') || !/acceptance|criteria|scenario|requirement|user story|business rule|definition of done/i.test(label)) continue;
    const value = fieldText(f[id]);
    if (value) lines.push('', `${label}:`, value);
  }
  if (f.subtasks?.length) lines.push('', 'Sub-tasks:', ...f.subtasks.map((s) => `- ${s.key} ${s.fields?.summary || ''}`));
  if (f.issuelinks?.length) {
    lines.push('', 'Linked issues:', ...f.issuelinks.map((l) => {
      const other = l.outwardIssue || l.inwardIssue;
      const rel = l.outwardIssue ? l.type?.outward : l.type?.inward;
      return other ? `- ${rel || 'relates to'} ${other.key} ${other.fields?.summary || ''}` : '';
    }).filter(Boolean));
  }
  return {
    key: issue.key,
    summary: f.summary || '',
    type: f.issuetype?.name || '',
    status: f.status?.name || '',
    url: `${settings.jira_base_url}/browse/${issue.key}`,
    text: lines.join('\n'),
  };
}
