import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from '../db.js';

// Models that accept the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Sends one request to the configured AI and returns the raw JSON text.
 *  - documents: PDFs ({ name, buffer }) sent to Claude natively; other providers get extracted text in the prompt
 *  - schema: JSON schema the answer must follow
 */
export async function complete({ settings, system, prompt, documents = [], schema }) {
  if (settings.ai_provider === 'openai') return completeOpenAICompatible({ settings, system, prompt, schema });
  return completeAnthropic({ settings, system, prompt, documents, schema });
}

async function completeAnthropic({ settings, system, prompt, documents, schema }) {
  if (!settings.ai_api_key && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new HttpError(400, 'No Anthropic API key configured. An admin can add one under Settings → AI, or set ANTHROPIC_API_KEY on the server.');
  }
  const client = new Anthropic(settings.ai_api_key ? { apiKey: settings.ai_api_key } : {});
  const model = settings.ai_model;
  const content = [];
  for (const d of documents) {
    if (d.mime === 'application/pdf' && d.buffer) {
      content.push({
        type: 'document',
        title: d.name,
        source: { type: 'base64', media_type: 'application/pdf', data: d.buffer.toString('base64') },
      });
    }
  }
  content.push({ type: 'text', text: prompt });

  const params = {
    model,
    max_tokens: 64000,
    system,
    messages: [{ role: 'user', content }],
    output_config: {
      format: { type: 'json_schema', schema },
      ...(EFFORTS.includes(settings.ai_effort) ? { effort: settings.ai_effort } : {}),
    },
  };

  let message;
  try {
    // Long inputs and outputs: stream, then collect the final message.
    const stream = FALLBACK_MODELS.has(model)
      ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : client.messages.stream(params);
    message = await stream.finalMessage();
  } catch (e) {
    throw anthropicError(e);
  }

  if (message.stop_reason === 'refusal') {
    throw new HttpError(422, 'The AI declined to process these requirements. Review the source text and try again.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new HttpError(422, 'The answer was too long and got cut off. Ask for fewer test cases or split the requirements into smaller parts.');
  }
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    text,
    model: message.model || model,
    usage: { input_tokens: message.usage?.input_tokens ?? null, output_tokens: message.usage?.output_tokens ?? null },
  };
}

function anthropicError(e) {
  if (e instanceof Anthropic.AuthenticationError) return new HttpError(400, 'The Anthropic API key was rejected. Check Settings → AI.');
  if (e instanceof Anthropic.PermissionDeniedError) return new HttpError(400, 'This API key has no access to the selected model.');
  if (e instanceof Anthropic.NotFoundError) return new HttpError(400, 'Model not found. Check the model name in Settings → AI.');
  if (e instanceof Anthropic.RateLimitError) return new HttpError(429, 'The AI rate limit was reached. Wait a minute and try again.');
  if (e instanceof Anthropic.BadRequestError) return new HttpError(400, `The AI rejected the request: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return new HttpError(502, 'Could not reach the Anthropic API. Check the server\'s internet connection.');
  if (e instanceof Anthropic.APIError) return new HttpError(502, `AI service error (${e.status ?? 'unknown'}). Try again later.`);
  if (e instanceof Anthropic.AnthropicError) return new HttpError(400, `${e.message}. An admin can add a key under Settings → AI.`);
  return e;
}

/**
 * Any server that speaks the OpenAI chat-completions API: Ollama, LM Studio, vLLM,
 * llama.cpp server, LocalAI, OpenRouter... Lets teams run open-source models locally.
 */
async function completeOpenAICompatible({ settings, system, prompt, schema }) {
  const base = (settings.ai_base_url || 'http://localhost:11434/v1').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (settings.ai_api_key) headers.Authorization = `Bearer ${settings.ai_api_key}`;
  const body = {
    model: settings.ai_model,
    stream: true, // headers arrive immediately, so slow local models don't hit HTTP timeouts
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${system}\n\nReply with a single JSON object that follows this JSON schema exactly, and nothing else:\n${JSON.stringify(schema)}` },
      { role: 'user', content: prompt }, // extracted document text is already inside the prompt
    ],
  };
  const send = async (payload) => {
    try {
      return await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30 * 60 * 1000) });
    } catch (e) {
      throw new HttpError(502, `Could not reach the AI server at ${base} (${e.cause?.code || e.message}). Check Settings → AI.`);
    }
  };
  let res = await send(body);
  let errText = res.ok ? '' : await res.text().catch(() => '');
  // Some models and providers reject response_format; the schema in the prompt is enough, so retry once without it.
  if (res.status === 400 && /response_format|json_object|json mode|structured/i.test(errText)) {
    const { response_format: _dropped, ...plain } = body;
    res = await send(plain);
    errText = res.ok ? '' : await res.text().catch(() => '');
  }
  if (!res.ok) throw upstreamError(res.status, errText, settings, base);

  let text = '';
  let usage = {};
  let finish = null;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nlIndex;
    while ((nlIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nlIndex).trim();
      buffer = buffer.slice(nlIndex + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const evt = JSON.parse(data);
        // OpenRouter and others report failures as an event inside an HTTP 200 stream
        if (evt.error) throw new HttpError(502, `The AI server returned an error: ${evt.error.message || JSON.stringify(evt.error)}`);
        text += evt.choices?.[0]?.delta?.content || '';
        finish = evt.choices?.[0]?.finish_reason || finish;
        if (evt.usage) usage = evt.usage;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        /* ignore keep-alive or partial lines */
      }
    }
  }
  if (finish === 'length') {
    throw new HttpError(422, 'The answer was cut off by the model\'s output limit. Ask for fewer test cases or split the requirements.');
  }
  return {
    text,
    model: settings.ai_model,
    usage: { input_tokens: usage.prompt_tokens ?? null, output_tokens: usage.completion_tokens ?? null },
  };
}

/** Turns a failed HTTP response from an OpenAI-compatible server into a message a tester can act on. */
function upstreamError(status, bodyText, settings, base) {
  let detail = String(bodyText || '').slice(0, 400);
  try {
    const j = JSON.parse(bodyText);
    detail = j.error?.message || j.message || (typeof j.error === 'string' ? j.error : detail);
  } catch { /* not JSON */ }
  if (status === 401 || status === 403) return new HttpError(400, `The AI server rejected the API key (HTTP ${status}). ${detail}`.trim());
  if (status === 402) return new HttpError(400, `The AI account has no credits left (HTTP 402). ${detail}`.trim());
  if (status === 404) return new HttpError(400, `Model "${settings.ai_model}" or endpoint not found on ${base}. ${detail}`.trim());
  if (status === 429) return new HttpError(429, `The AI server rate limit was reached. ${detail}`.trim());
  if (status === 400) return new HttpError(400, `The AI server rejected the request: ${detail} (model: ${settings.ai_model}). Check the model name in Settings → AI.`);
  return new HttpError(502, `AI server error ${status}: ${detail}`);
}

/** Pulls the JSON object out of a model reply, tolerating code fences or stray prose. */
export function parseJsonReply(text) {
  const cleaned = String(text || '').replace(/^﻿/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
  }
  throw new HttpError(502, 'The AI reply was not valid JSON. Try again, or use a more capable model.');
}
