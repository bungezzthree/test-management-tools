import express from 'express';
import multer from 'multer';
import { HttpError } from './db.js';
import { requireRole } from './auth.js';
import { ah, toInt, getProject, getSuite } from './services.js';
import { getSettings, publicSettings, saveSettings, DEFAULT_MODELS } from './settings.js';
import { extractDocument, DOCUMENT_TYPES } from './ai/extract.js';
import { parseIssueKeys, fetchIssue, testJira } from './ai/jira.js';
import { complete, parseJsonReply } from './ai/providers.js';
import { generate, createFromDrafts, recentGenerations, hasGeneration } from './ai/generator.js';
import { toCsv, toXlsx } from './importExport.js';

const MAX_JIRA_ISSUES = 20;
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 10 } });
const admin = requireRole();
const tester = requireRole('tester');

export const ai = express.Router();

const aiConfigured = (s) => (s.ai_provider === 'openai'
  ? Boolean(s.ai_base_url && s.ai_model)
  : Boolean(s.ai_api_key || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN));

/* ------------------------------------------------------------------ settings (admin) */

ai.get('/settings', admin, (req, res) => res.json({ ...publicSettings(), default_models: DEFAULT_MODELS }));

ai.put('/settings', admin, ah((req, res) => {
  const b = req.body || {};
  if (b.ai_provider && !['anthropic', 'openai'].includes(b.ai_provider)) throw new HttpError(400, 'Unknown AI provider');
  for (const k of ['ai_base_url', 'jira_base_url']) {
    if (b[k] && !/^https?:\/\/[^\s]+$/i.test(String(b[k]).trim())) throw new HttpError(400, `${k === 'jira_base_url' ? 'Jira URL' : 'AI server URL'} must start with http:// or https://`);
  }
  saveSettings(b);
  res.json({ ok: true });
}));

ai.post('/settings/test-ai', admin, ah(async (req, res) => {
  const settings = getSettings();
  const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
  const started = Date.now();
  const r = await complete({ settings, system: 'You are a connectivity check.', prompt: 'Reply with {"ok": true}.', schema });
  parseJsonReply(r.text);
  res.json({ ok: true, provider: settings.ai_provider, model: r.model, ms: Date.now() - started });
}));

ai.post('/settings/test-jira', admin, ah(async (req, res) => {
  res.json({ ok: true, ...(await testJira(getSettings())) });
}));

/* ------------------------------------------------------------------ status & Jira preview */

ai.get('/ai/status', (req, res) => {
  const s = getSettings();
  res.json({
    ai_configured: aiConfigured(s),
    provider: s.ai_provider,
    model: s.ai_model,
    jira_configured: Boolean(s.jira_base_url),
    jira_base_url: s.jira_base_url || null,
    document_types: DOCUMENT_TYPES,
  });
});

async function loadIssues(input) {
  const keys = parseIssueKeys(input);
  if (keys.length > MAX_JIRA_ISSUES) throw new HttpError(400, `Use at most ${MAX_JIRA_ISSUES} Jira issues at a time.`);
  const settings = getSettings();
  return Promise.all(keys.map((k) => fetchIssue(settings, k)));
}

ai.get('/jira/issues', tester, ah(async (req, res) => {
  const keys = parseIssueKeys(req.query.keys);
  if (!keys.length) throw new HttpError(400, 'Enter a Jira issue key such as PAY-123, or paste the issue URL.');
  const settings = getSettings();
  const results = await Promise.all(keys.slice(0, MAX_JIRA_ISSUES).map(async (k) => {
    try {
      const i = await fetchIssue(settings, k);
      return { key: i.key, summary: i.summary, type: i.type, status: i.status, url: i.url, chars: i.text.length };
    } catch (e) {
      return { key: k, error: e.message };
    }
  }));
  res.json(results);
}));

/* ------------------------------------------------------------------ generate → review → create */

ai.post('/projects/:id/ai/generate', tester, docUpload.array('documents'), ah(async (req, res) => {
  const projectId = toInt(req.params.id);
  getProject(projectId);
  if (!aiConfigured(getSettings())) throw new HttpError(400, 'AI is not configured yet. An admin can set it up under Settings → AI.');
  let b;
  try {
    b = JSON.parse(req.body.data || '{}');
  } catch {
    throw new HttpError(400, 'Invalid request');
  }
  const targetSuiteId = toInt(b.target_suite_id);
  if (targetSuiteId && getSuite(targetSuiteId).project_id !== projectId) throw new HttpError(400, 'Suite belongs to another project');
  const documents = [];
  for (const f of req.files || []) documents.push(await extractDocument(f));
  const jiraIssues = b.jira ? await loadIssues(b.jira) : [];
  const result = await generate({
    projectId,
    userId: req.user.id,
    text: String(b.text || '').trim(),
    documents,
    jiraIssues,
    options: {
      language: b.language === 'id' ? 'id' : 'en',
      coverage: Array.isArray(b.coverage) ? b.coverage : [],
      count: ['5', '10', '20', '40'].includes(String(b.count)) ? String(b.count) : 'auto',
      group: Boolean(b.group),
      instructions: String(b.instructions || '').trim().slice(0, 4000),
      target_suite_id: targetSuiteId,
    },
  });
  res.json(result);
}));

ai.post('/projects/:id/ai/create', tester, ah((req, res) => {
  const projectId = toInt(req.params.id);
  getProject(projectId);
  const b = req.body || {};
  const generationId = toInt(b.generation_id);
  const result = createFromDrafts({
    projectId,
    userId: req.user.id,
    targetSuiteId: toInt(b.target_suite_id),
    newSuiteName: b.new_suite_name,
    parentSuiteId: toInt(b.parent_suite_id),
    status: b.status,
    cases: b.cases,
    generationId: generationId && hasGeneration(generationId, projectId) ? generationId : null,
  });
  res.status(201).json(result);
}));

/** Drafts → the same spreadsheet layout as Import / Export, for editing in Excel before import. */
ai.post('/projects/:id/ai/export', ah(async (req, res) => {
  const project = getProject(toInt(req.params.id));
  const cases = Array.isArray(req.body?.cases) ? req.body.cases.slice(0, 500) : [];
  if (!cases.length) throw new HttpError(400, 'No test cases to export');
  const rows = [];
  for (const c of cases) {
    const base = {
      suite: c.suite || '', case_key: '', title: c.title, objective: c.objective, preconditions: c.preconditions,
      priority: c.priority, test_type: c.test_type, execution_type: 'Manual', status: 'Draft',
      requirement_ref: c.requirement_ref, tags: c.tags,
    };
    const steps = Array.isArray(c.steps) && c.steps.length ? c.steps : [{}];
    steps.forEach((st, i) => rows.push({
      ...(i === 0 ? base : {}), step_no: st.action ? i + 1 : '', action: st.action, test_data: st.test_data, expected_result: st.expected_result,
    }));
  }
  const name = `${project.prefix}-ai-generated-test-cases`;
  if (req.body.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(toCsv(rows));
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  res.send(await toXlsx(rows, 'AI Test Cases'));
}));

ai.get('/projects/:id/ai/history', ah((req, res) => {
  const projectId = toInt(req.params.id);
  getProject(projectId);
  res.json(recentGenerations(projectId));
}));
