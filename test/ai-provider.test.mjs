// AI provider error handling against a stand-in OpenAI-compatible server (OpenRouter-style): node --test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server; let upstream; let base; let dataDir; let cookie; let upstreamPort;
let mode = 'ok';
const seen = [];

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const api = async (method, url, body) => {
  const res = await fetch(`${base}/api${url}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};
const configure = (model) => api('PUT', '/settings', { ai_provider: 'openai', ai_model: model, ai_base_url: `http://127.0.0.1:${upstreamPort}/api/v1`, ai_api_key: 'sk-or-test' });

before(async () => {
  upstreamPort = await freePort();
  upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (body.model === 'llama3.1') return json(400, { error: { message: 'llama3.1 is not a valid model ID', code: 400 } });
      if (body.model === 'no-credit') return json(402, { error: { message: 'Insufficient credits' } });
      if (body.model === 'no-json-mode' && body.response_format) return json(400, { error: { message: 'This model does not support response_format' } });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (body.model === 'mid-stream-error') {
        res.write(': OPENROUTER PROCESSING\n\n');
        res.write(`data: ${JSON.stringify({ error: { message: 'Provider returned error' } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.write(': OPENROUTER PROCESSING\n\n');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok": ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  }).listen(upstreamPort);

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testdesk-ai-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: root, env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', ADMIN_PASSWORD: 'admin-pass-1' }, stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(base); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-pass-1' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  upstream?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('a working OpenRouter-style server passes the connection test', async () => {
  await configure('meta-llama/llama-3.3-70b-instruct');
  const r = await api('POST', '/settings/test-ai');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  const last = seen.at(-1);
  assert.equal(last.url, '/api/v1/chat/completions');
  assert.equal(last.auth, 'Bearer sk-or-test');
});

test('an invalid model name shows the provider message, not "Internal server error"', async () => {
  await configure('llama3.1');
  const r = await api('POST', '/settings/test-ai');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /llama3\.1 is not a valid model ID/);
  assert.notEqual(r.data.error, 'Internal server error');
});

test('out of credits is explained', async () => {
  await configure('no-credit');
  const r = await api('POST', '/settings/test-ai');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /no credits/i);
});

test('errors reported inside a 200 stream are surfaced', async () => {
  await configure('mid-stream-error');
  const r = await api('POST', '/settings/test-ai');
  assert.equal(r.status, 502);
  assert.match(r.data.error, /Provider returned error/);
});

test('models without JSON mode are retried without response_format', async () => {
  await configure('no-json-mode');
  const before = seen.length;
  const r = await api('POST', '/settings/test-ai');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(seen.length - before, 2);
  assert.equal(seen.at(-1).body.response_format, undefined);
});

test('an unreachable server gives an actionable message', async () => {
  await api('PUT', '/settings', { ai_provider: 'openai', ai_model: 'x', ai_base_url: 'http://127.0.0.1:9/v1' });
  const r = await api('POST', '/settings/test-ai');
  assert.equal(r.status, 502);
  assert.match(r.data.error, /Could not reach the AI server/);
});
