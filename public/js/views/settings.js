import { GET, PUT, POST, can } from '../api.js';
import { esc, $, toast, options, formValues } from '../ui.js';
import { refresh } from '../app.js';

const CLAUDE_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];
const OPEN_MODELS = ['llama3.1', 'llama3.3', 'qwen2.5', 'qwen3', 'mistral-small', 'gemma3', 'deepseek-r1'];

export async function renderSettings(main) {
  if (!can.admin()) { main.innerHTML = '<div class="page">Admins only.</div>'; return; }
  const s = await GET('/settings');
  main.innerHTML = `
    <div class="page">
      <div class="page-head"><div><h1>Settings</h1><p class="muted">Connections used by the AI Test Case Generator.</p></div></div>
      <div class="two-col">
        <form class="card pad" id="aiForm">
          <h2>AI model</h2>
          <fieldset><legend>Provider</legend>
            <div class="radio-cards">
              <label><input type="radio" name="ai_provider" value="anthropic" ${s.ai_provider !== 'openai' ? 'checked' : ''}> <b>Claude (Anthropic API)</b>
                <span>Best quality. Reads PDFs directly, including tables and scanned pages. Needs an API key from console.anthropic.com; usage is billed per token.</span></label>
              <label><input type="radio" name="ai_provider" value="openai" ${s.ai_provider === 'openai' ? 'checked' : ''}> <b>Open-source model (self-hosted)</b>
                <span>Any OpenAI-compatible server: Ollama, LM Studio, vLLM, llama.cpp, LocalAI. Requirements stay on your network. Quality depends on the model.</span></label>
            </div>
          </fieldset>
          <label>Model<input name="ai_model" value="${esc(s.ai_model)}" list="modelList" required>
            <datalist id="modelList"></datalist></label>
          <label id="baseUrlWrap">Server URL <span class="hint">e.g. http://localhost:11434/v1 for Ollama, http://localhost:1234/v1 for LM Studio</span>
            <input name="ai_base_url" value="${esc(s.ai_base_url)}" placeholder="http://localhost:11434/v1"></label>
          <label>API key <span class="hint" id="keyHint"></span>
            <input name="ai_api_key" type="password" autocomplete="off" placeholder="${s.ai_api_key_set ? '•••••••• saved — leave blank to keep' : ''}"></label>
          ${s.ai_api_key_set ? '<label class="check small"><input type="checkbox" name="clear_ai_api_key"> Remove the saved key</label>' : ''}
          <div class="grid2">
            <label id="effortWrap">Effort <span class="hint">Claude only</span><select name="ai_effort">${options([['low', 'Low — fastest'], ['medium', 'Medium'], ['high', 'High (recommended)'], ['xhigh', 'Extra high'], ['max', 'Max — slowest']], s.ai_effort)}</select></label>
            <label>Max requirement size <span class="hint">characters</span><input name="ai_max_input_chars" type="number" min="1000" value="${esc(s.ai_max_input_chars)}"></label>
          </div>
          <div class="form-error" id="aiError"></div>
          <div class="actions"><button class="btn primary">Save</button><button type="button" class="btn" id="testAi">Test connection</button><span class="small" id="aiResult"></span></div>
        </form>

        <form class="card pad" id="jiraForm">
          <h2>Jira</h2>
          <p class="muted small">Lets testers pull user stories and acceptance criteria straight from Jira issues. Read-only; nothing is written back to Jira.</p>
          <label>Jira URL<input name="jira_base_url" value="${esc(s.jira_base_url)}" placeholder="https://yourcompany.atlassian.net"></label>
          <label>Email <span class="hint">Jira Cloud only; leave blank for Jira Server / Data Center</span><input name="jira_email" type="email" value="${esc(s.jira_email)}"></label>
          <label>API token <span class="hint">Cloud: id.atlassian.com → Security → API tokens. Server/DC: a personal access token.</span>
            <input name="jira_token" type="password" autocomplete="off" placeholder="${s.jira_token_set ? '•••••••• saved — leave blank to keep' : ''}"></label>
          ${s.jira_token_set ? '<label class="check small"><input type="checkbox" name="clear_jira_token"> Remove the saved token</label>' : ''}
          <p class="muted small">Use a dedicated read-only Jira account where possible. Tokens are stored in the server database (<code>data/testmgmt.db</code>); to keep them out of it, set <code>JIRA_API_TOKEN</code> and <code>ANTHROPIC_API_KEY</code> as environment variables instead.</p>
          <div class="form-error" id="jiraError"></div>
          <div class="actions"><button class="btn primary">Save</button><button type="button" class="btn" id="testJira">Test connection</button><span class="small" id="jiraResult"></span></div>
        </form>
      </div>
    </div>`;

  const aiForm = $('#aiForm');
  const syncProvider = () => {
    const open = aiForm.ai_provider.value === 'openai';
    $('#baseUrlWrap').hidden = !open;
    $('#effortWrap').style.visibility = open ? 'hidden' : '';
    $('#modelList').innerHTML = (open ? OPEN_MODELS : CLAUDE_MODELS).map((m) => `<option value="${m}">`).join('');
    $('#keyHint').textContent = open ? 'optional; only if your server requires one' : 'required unless ANTHROPIC_API_KEY is set on the server';
  };
  syncProvider();
  aiForm.addEventListener('change', (e) => {
    if (e.target.name !== 'ai_provider') return;
    syncProvider();
    const isClaude = (m) => m.startsWith('claude-');
    const open = e.target.value === 'openai';
    if (open === isClaude(aiForm.ai_model.value)) aiForm.ai_model.value = s.default_models[e.target.value];
  });

  const saveForm = async (form, errEl) => {
    $(errEl).textContent = '';
    const v = formValues(form);
    if (form.ai_max_input_chars) v.ai_max_input_chars = String(v.ai_max_input_chars || '');
    await PUT('/settings', v);
  };
  aiForm.onsubmit = async (e) => {
    e.preventDefault();
    try { await saveForm(aiForm, '#aiError'); toast('AI settings saved'); refresh(); } catch (ex) { $('#aiError').textContent = ex.message; }
  };
  $('#jiraForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await saveForm($('#jiraForm'), '#jiraError'); toast('Jira settings saved'); refresh(); } catch (ex) { $('#jiraError').textContent = ex.message; }
  };

  const tester = (btnSel, outSel, path, describe) => {
    $(btnSel).onclick = async () => {
      const out = $(outSel);
      out.className = 'small muted';
      out.textContent = 'Testing… (save first if you changed anything)';
      try {
        const r = await POST(path);
        out.className = 'small t-passed';
        out.textContent = describe(r);
      } catch (ex) {
        out.className = 'small t-failed';
        out.textContent = ex.message;
      }
    };
  };
  tester('#testAi', '#aiResult', '/settings/test-ai', (r) => `✔ Connected to ${r.model} (${(r.ms / 1000).toFixed(1)}s)`);
  tester('#testJira', '#jiraResult', '/settings/test-jira', (r) => `✔ Connected as ${r.name}`);
}
