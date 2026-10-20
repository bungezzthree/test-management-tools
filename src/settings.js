import { all, run } from './db.js';

/**
 * Admin-editable settings for the AI generator and Jira. Environment variables
 * fill in anything left blank in the UI, so secrets can stay out of the database.
 */
export const SETTING_DEFS = {
  ai_provider: { env: 'AI_PROVIDER', default: 'anthropic' }, // anthropic | openai
  ai_model: { env: 'AI_MODEL', default: '' },
  ai_api_key: { env: null, secret: true, default: '' }, // anthropic falls back to ANTHROPIC_API_KEY via the SDK
  ai_base_url: { env: 'AI_BASE_URL', default: '' }, // OpenAI-compatible servers, e.g. http://localhost:11434/v1
  ai_effort: { env: 'AI_EFFORT', default: 'high' },
  ai_max_input_chars: { env: 'AI_MAX_INPUT_CHARS', default: '400000' },
  jira_base_url: { env: 'JIRA_BASE_URL', default: '' },
  jira_email: { env: 'JIRA_EMAIL', default: '' },
  jira_token: { env: 'JIRA_API_TOKEN', secret: true, default: '' },
};

export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'llama3.1',
};

export function getSettings() {
  const stored = Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  const out = {};
  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    out[key] = stored[key] || (def.env && process.env[def.env]) || def.default;
  }
  if (!out.ai_model) out.ai_model = DEFAULT_MODELS[out.ai_provider] || '';
  if (!out.ai_api_key && out.ai_provider === 'openai') out.ai_api_key = process.env.AI_API_KEY || '';
  if (!out.jira_token) out.jira_token = process.env.JIRA_API_TOKEN || '';
  out.jira_base_url = out.jira_base_url.replace(/\/+$/, '');
  return out;
}

/** Settings safe to show in the admin screen: secrets are reported as set/unset only. */
export function publicSettings() {
  const s = getSettings();
  const out = {};
  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    out[key] = def.secret ? '' : s[key];
    if (def.secret) out[`${key}_set`] = Boolean(s[key]) || (key === 'ai_api_key' && s.ai_provider === 'anthropic' && Boolean(process.env.ANTHROPIC_API_KEY));
  }
  return out;
}

export function saveSettings(body) {
  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    if (!(key in body)) continue;
    const value = String(body[key] ?? '').trim();
    // blank secret fields mean "keep the current value"; clear them explicitly with clear_<key>
    if (def.secret && !value && !body[`clear_${key}`]) continue;
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }
}
