// LLM calls made from the service worker. Plain fetch + SSE parsing, because the
// extension is loaded unpacked with no build step (no bundler for an SDK).

import { DEFAULT_FOLLOWUP_PROMPT, DEFAULT_SYSTEM_PROMPT, PROVIDERS } from './settings.js';
import { formatInstruction, noteForContext } from './note-format.js';
import { tr } from './i18n.js';

const ANTHROPIC_VERSION = '2026-10-21';
// Models that accept the server-side `fallbacks: "default"` parameter on the Claude API:
// when a safety classifier declines, the API retries on a recommended model in the same call.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
// Older models that reject output_config.effort.
const NO_EFFORT = /^claude-(3|sonnet-4-5|haiku-4-5|sonnet-4-0|opus-4-0|opus-4-1|sonnet-4-2)/;
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export function buildUserMessage(page, ann) {
  return [
    `网页标题：${page.title || '（无）'}`,
    `网址：${page.url}`,
    '',
    '<paragraph>',
    ann.context || ann.quote,
    '</paragraph>',
    '',
    '<selection>',
    ann.quote,
    '</selection>',
  ].join('\n');
}

function systemPrompt(settings) {
  return (settings.systemPrompt || '').trim() || DEFAULT_SYSTEM_PROMPT;
}

function followupPrompt(settings) {
  return (settings.followupPrompt || '').trim() || DEFAULT_FOLLOWUP_PROMPT;
}

/** Generate the note for one annotation. Calls onText(fullTextSoFar) while streaming. */
export function generateNote({ settings, page, ann, signal, onText }) {
  return callModel({
    settings,
    system: `${systemPrompt(settings)}\n\n${formatInstruction(settings, ann.quote)}`,
    messages: [{ role: 'user', content: buildUserMessage(page, ann) }],
    maxTokens: 16000,
    signal,
    onText,
  });
}

/**
 * Answer follow-up `turnId` on an annotation: the conversation is the original request, the
 * note, every earlier follow-up that got an answer, then this question.
 */
export function generateFollowup({ settings, page, ann, turnId, signal, onText }) {
  const messages = [
    { role: 'user', content: buildUserMessage(page, ann) },
    { role: 'assistant', content: noteForContext(ann) },
  ];
  for (const t of ann.thread || []) {
    if (t.id === turnId) {
      messages.push({ role: 'user', content: t.q });
      break;
    }
    if (t.status === 'done' && t.a) messages.push({ role: 'user', content: t.q }, { role: 'assistant', content: t.a });
  }
  return callModel({
    settings,
    system: followupPrompt(settings), // its own prompt: follow-ups are not held to the note's brevity
    messages,
    maxTokens: 16000,
    signal,
    onText,
  });
}

export async function testConnection(settings) {
  const res = await callModel({
    settings,
    system: '你是连接测试助手。',
    messages: [{ role: 'user', content: '请只回复两个字：成功' }],
    maxTokens: 2048,
    signal: AbortSignal.timeout(60000),
    onText: () => {},
  });
  return { ok: true, model: res.model, text: res.text.trim().slice(0, 200) };
}

async function callModel(opts) {
  const { settings } = opts;
  if (!settings.apiKey) throw new Error(tr('errNoKey'));
  if (!settings.model) throw new Error(tr('errNoModel'));
  if (settings.provider === 'gemini') return geminiWithFallback(opts);
  return settings.provider === 'openai' ? streamOpenAI(opts) : streamAnthropic(opts);
}

function baseUrlFor(settings) {
  const fallback = (PROVIDERS[settings.provider] || PROVIDERS.anthropic).baseUrl;
  return ((settings.baseUrl || '').trim() || fallback).replace(/\/+$/, '');
}

// ---------------------------------------------------------------- Anthropic

async function streamAnthropic({ settings, system, messages, maxTokens, signal, onText }) {
  const base = baseUrlFor(settings);
  const model = settings.model.trim();
  const official = /^https:\/\/api\.anthropic\.com$/i.test(base);
  const useFallbacks = official && FALLBACK_MODELS.has(model);
  let sendEffort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(settings.effort) && !NO_EFFORT.test(model);

  const makeRequest = () => {
    const body = {
      model,
      max_tokens: maxTokens,
      stream: true,
      system,
      messages,
    };
    if (sendEffort) body.output_config = { effort: settings.effort };
    if (useFallbacks) body.fallbacks = 'default';
    const headers = {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey.trim(),
      'anthropic-version': ANTHROPIC_VERSION,
      // Requests from an extension carry a chrome-extension:// Origin; the API requires this opt-in.
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (useFallbacks) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    return fetch(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  };

  let res;
  try {
    res = await fetchWithRetry(makeRequest, signal);
  } catch (err) {
    // A custom proxy or an older model may not understand `effort`; retry once without it.
    if (sendEffort && err.status === 400 && /effort|output_config/i.test(err.message)) {
      sendEffort = false;
      res = await fetchWithRetry(makeRequest, signal);
    } else {
      throw err;
    }
  }

  let text = '';
  let usedModel = model;
  let stopReason = null;
  let stopDetails = null;
  let fellBack = false;

  for await (const { event, data } of sseEvents(res)) {
    if (data === '[DONE]') break;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const type = payload.type || event;
    if (type === 'message_start') {
      usedModel = payload.message?.model || usedModel;
    } else if (type === 'content_block_start') {
      if (payload.content_block?.type === 'fallback') fellBack = true;
    } else if (type === 'content_block_delta') {
      if (payload.delta?.type === 'text_delta') {
        text += payload.delta.text;
        onText(text);
      }
    } else if (type === 'message_delta') {
      stopReason = payload.delta?.stop_reason ?? stopReason;
      stopDetails = payload.delta?.stop_details ?? stopDetails;
    } else if (type === 'error') {
      throw new Error(tr('errApi', payload.error?.message || data));
    }
  }

  if (stopReason === 'refusal') {
    const cat = stopDetails?.category ? tr('refusalCategory', stopDetails.category) : '';
    throw new Error(tr('errRefused', cat));
  }
  if (stopReason === 'max_tokens') text += `\n\n${tr('truncated')}`;
  if (!text.trim()) throw new Error(tr('errNoText', `stop_reason: ${stopReason || tr('unknown')}`));
  return { text, model: fellBack ? tr('modelFellBack', usedModel) : usedModel };
}

// ---------------------------------------------------------------- Gemini (native API, auto model selection)
//
// Free-tier Gemini models are often overloaded (503) or rate-limited (429), and the best
// model changes over time. In "auto" mode we discover the Flash models the key can use,
// try them newest-first, put failing ones on a cooldown, and probe cooled-down models in
// the background so a recovered better model is picked up again.

const GEMINI_STATIC_CHAIN = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite'];
const GEMINI_FIRST_BYTE_MS = 25000; // give up on a model that hasn't started answering by then
const GEMINI_HEDGE_MS = 10000; // ...but start the next candidate in parallel after this long
const GEMINI_MAX_ATTEMPTS = 4;
const MODELS_TTL_MS = 24 * 3600 * 1000;

function geminiBase(settings) {
  return baseUrlFor(settings).replace(/\/v1(beta)?$/, '');
}

/** Ordered list of usable Flash models, newest first; Lite models last. Cached for a day. */
async function geminiChain(settings) {
  const cacheKey = 'geminiModels';
  const { [cacheKey]: cached } = await chrome.storage.local.get(cacheKey);
  const keyTag = settings.apiKey.trim().slice(-6);
  if (cached && cached.keyTag === keyTag && Date.now() - cached.at < MODELS_TTL_MS && cached.list?.length) return cached.list;
  try {
    const res = await fetch(`${geminiBase(settings)}/v1beta/models?pageSize=300`, {
      headers: { 'x-goog-api-key': settings.apiKey.trim() },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw await httpError(res);
    const { models = [] } = await res.json();
    const ranked = [];
    for (const m of models) {
      if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      const id = m.name.replace(/^models\//, '');
      const hit = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?(-preview)?$/.exec(id);
      if (!hit) continue;
      const version = Number(hit[1]);
      if (version < 3) continue; // 2.x is closed to new keys
      ranked.push({ id, version, lite: !!hit[2], preview: !!hit[3] });
    }
    ranked.sort((a, b) => a.lite - b.lite || b.version - a.version || a.preview - b.preview);
    const list = ranked.map((r) => r.id);
    if (!list.length) throw new Error('no flash models');
    await chrome.storage.local.set({ [cacheKey]: { at: Date.now(), keyTag, list } });
    return list;
  } catch {
    return GEMINI_STATIC_CHAIN;
  }
}

// Model health is persisted so a browser restart doesn't re-discover every overloaded model
// the slow way; entries are time-boxed cooldowns, so stale ones simply expire.
async function loadHealth() {
  const { geminiHealth } = await chrome.storage.local.get('geminiHealth');
  return geminiHealth || {};
}

// Probes and requests finish concurrently; serialize read-modify-write so updates aren't lost.
let healthLock = Promise.resolve();
function saveHealth(mutator) {
  const run = healthLock.then(async () => {
    const health = await loadHealth();
    mutator(health);
    await chrome.storage.local.set({ geminiHealth: health });
  });
  healthLock = run.catch(() => {});
  return run;
}

function cooldownFor(err) {
  const text = `${err.message} ${err.detail || ''}`;
  if (err.status === 404 || err.status === 400) return 24 * 3600e3;
  if (err.status === 429) return /PerDay/i.test(text) ? 6 * 3600e3 : 90e3;
  return 10 * 60e3; // 503 overload, 5xx, first-byte timeout, network
}

function markFailed(model, err) {
  return saveHealth((h) => {
    h[model] = { until: Date.now() + cooldownFor(err), reason: String(err.message).slice(0, 120) };
  });
}

function markOk(model) {
  return saveHealth((h) => {
    delete h[model];
  });
}

const probing = new Set();
function probeInBackground(settings, model) {
  if (probing.has(model)) return;
  probing.add(model);
  streamGemini({
    settings,
    model,
    system: '只回复：好',
    messages: [{ role: 'user', content: '在吗' }],
    maxTokens: 2048,
    signal: AbortSignal.timeout(GEMINI_FIRST_BYTE_MS + 5000),
    onText: () => {},
    thinking: 'low',
  })
    .then(() => markOk(model), (err) => markFailed(model, err))
    .finally(() => probing.delete(model));
}

async function geminiWithFallback(opts) {
  const { settings, signal } = opts;
  const chosen = settings.model.trim();
  const auto = chosen === 'auto';
  let chain = await geminiChain(settings);
  if (!auto) chain = [chosen, ...chain.filter((m) => m !== chosen)];

  const now = Date.now();
  const health = await loadHealth();
  const healthy = chain.filter((m) => !health[m]);
  const recovered = chain.filter((m) => health[m] && health[m].until <= now); // cooldown over, not yet re-verified
  const cooling = chain.filter((m) => health[m] && health[m].until > now);

  // Never make the reader wait on a model that failed recently: a better model whose cooldown
  // is over gets re-checked in the background, and is used again once that probe succeeds.
  const best = chain.indexOf(healthy[0]);
  const toProbe = healthy.length ? recovered.filter((m) => chain.indexOf(m) < best) : [];
  toProbe.forEach((m) => probeInBackground(settings, m));
  const queue = [...healthy, ...recovered.filter((m) => !toProbe.includes(m)), ...cooling].slice(0, GEMINI_MAX_ATTEMPTS);
  const rank = (m) => queue.indexOf(m);

  // Hedged racing: start the best candidate; if it fails, or hasn't produced text within
  // GEMINI_HEDGE_MS, start the next one alongside it. The first model to stream text wins and
  // the others are cancelled. Answers from different models are never spliced together.
  return new Promise((resolve, reject) => {
    const running = new Map(); // model -> AbortController
    const errors = [];
    let next = 0;
    let winner = null;
    let settled = false;
    let hedgeTimer = null;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      signal?.removeEventListener('abort', onOuterAbort);
      for (const [m, c] of running) if (m !== winner) c.abort();
      fn();
    };
    const failIfExhausted = () => {
      if (!running.size && next >= queue.length) {
        finish(() => reject(new Error(tr('errAllModels', errors.join('\n')))));
      }
    };
    function onOuterAbort() {
      for (const c of running.values()) c.abort(signal.reason);
      finish(() => reject(signal.reason));
    }
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    const launchNext = () => {
      clearTimeout(hedgeTimer);
      if (settled || winner || next >= queue.length) return failIfExhausted();
      const model = queue[next++];
      const ctrl = new AbortController();
      running.set(model, ctrl);

      streamGemini({
        ...opts,
        model,
        thinking: settings.effort,
        signal: ctrl.signal,
        onText: (t) => {
          if (settled) return;
          if (!winner) {
            winner = model;
            clearTimeout(hedgeTimer);
            for (const [m, c] of running) {
              if (m === model) continue;
              c.abort();
              // A better-ranked model that was beaten to the first word is too slow right now.
              if (rank(m) < rank(model)) markFailed(m, { message: tr('slowerThan', model) });
            }
          }
          if (winner === model) opts.onText(t);
        },
      }).then(
        (res) => {
          running.delete(model);
          if (settled || (winner && winner !== model)) return;
          markOk(model);
          const label = auto || model === chosen ? res.model : tr('modelSwapped', res.model, chosen);
          finish(() => resolve({ ...res, model: label }));
        },
        (err) => {
          running.delete(model);
          if (settled || (winner && winner !== model)) return; // cancelled loser
          if (winner === model || !err.retryable) return finish(() => reject(err)); // mid-answer failure or a real error
          errors.push(`${model}：${String(err.message).slice(0, 80)}`);
          markFailed(model, err);
          launchNext(); // failed fast: try the next one right away
          failIfExhausted();
        },
      );

      if (next < queue.length) hedgeTimer = setTimeout(launchNext, GEMINI_HEDGE_MS);
    };

    launchNext();
  });
}

async function streamGemini({ settings, model, system, messages, maxTokens, signal, onText, thinking }) {
  const url = `${geminiBase(settings)}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  let sendThinking = ['low', 'medium', 'high'].includes(thinking);

  const attempt = async () => {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, GEMINI_FIRST_BYTE_MS);
    const generationConfig = { maxOutputTokens: maxTokens };
    if (sendThinking) generationConfig.thinkingConfig = { thinkingLevel: thinking };
    try {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.apiKey.trim() },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
            generationConfig,
          }),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        const e = new Error(timedOut ? tr('noResponseIn', GEMINI_FIRST_BYTE_MS / 1000) : tr('errNetwork', err.message));
        e.retryable = true;
        throw e;
      }
      if (!res.ok) {
        const e = await httpError(res);
        e.retryable = [404, 408, 429, 500, 502, 503, 504].includes(res.status);
        throw e;
      }

      let text = '';
      let finish = null;
      let usedModel = model;
      let blocked = null;
      try {
        for await (const { data } of sseEvents(res)) {
          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (payload.error) {
            const e = new Error(tr('errApi', payload.error.message || data));
            e.status = payload.error.code;
            e.retryable = !text && [429, 500, 503].includes(payload.error.code);
            throw e;
          }
          usedModel = payload.modelVersion || usedModel;
          blocked = payload.promptFeedback?.blockReason || blocked;
          const cand = payload.candidates?.[0];
          for (const part of cand?.content?.parts || []) {
            if (part.text && !part.thought) {
              text += part.text;
              if (timer) clearTimeout(timer);
              onText(text);
            }
          }
          if (cand?.finishReason) finish = cand.finishReason;
        }
      } catch (err) {
        if (signal?.aborted || err.status) throw err;
        const e = new Error(timedOut ? tr('noResponseIn', GEMINI_FIRST_BYTE_MS / 1000) : tr('errConnLost', err.message));
        e.retryable = !text;
        throw e;
      }

      if (blocked) throw new Error(tr('errGeminiBlocked', blocked));
      if (finish && !['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'].includes(finish) && !text.trim()) {
        throw new Error(tr('errGeminiEmpty', finish));
      }
      if (finish === 'MAX_TOKENS') text += `\n\n${tr('truncated')}`;
      if (!text.trim()) {
        const e = new Error(tr('errNoText', `finishReason: ${finish || tr('unknown')}`));
        e.retryable = true;
        throw e;
      }
      return { text, model: usedModel };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  try {
    return await attempt();
  } catch (err) {
    // Some models reject thinkingConfig/thinkingLevel; retry once without it.
    if (sendThinking && err.status === 400 && /thinking/i.test(err.message)) {
      sendThinking = false;
      return attempt();
    }
    throw err;
  }
}

// ---------------------------------------------------------------- OpenAI-compatible

async function streamOpenAI({ settings, system, messages, maxTokens, signal, onText }) {
  const base = baseUrlFor(settings);
  const model = settings.model.trim();
  const makeRequest = () =>
    fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          ...messages,
        ],
      }),
      signal,
    });

  const res = await fetchWithRetry(makeRequest, signal);
  let text = '';
  let usedModel = model;
  let finish = null;
  for await (const { data } of sseEvents(res)) {
    if (data === '[DONE]') break;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    if (payload.error) throw new Error(tr('errApi', payload.error.message || data));
    usedModel = payload.model || usedModel;
    const choice = payload.choices?.[0];
    const piece = choice?.delta?.content;
    if (piece) {
      text += piece;
      onText(text);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  if (finish === 'length') text += `\n\n${tr('truncated')}`;
  if (!text.trim()) throw new Error(tr('errNoText', `finish_reason: ${finish || tr('unknown')}`));
  return { text, model: usedModel };
}

// ---------------------------------------------------------------- HTTP helpers

async function fetchWithRetry(makeRequest, signal, attempts = 3) {
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await makeRequest();
    } catch (err) {
      if (signal?.aborted) throw err;
      if (i + 1 < attempts) {
        await sleep(1000 * (i + 1), signal);
        continue;
      }
      throw new Error(tr('errNetworkHint', err.message));
    }
    if (res.ok) return res;
    if (RETRYABLE.has(res.status) && i + 1 < attempts) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra > 0 && ra <= 20 ? ra * 1000 : 1500 * (i + 1), signal);
      continue;
    }
    throw await httpError(res);
  }
}

async function httpError(res) {
  let message = '';
  let raw = '';
  try {
    raw = await res.text();
    try {
      const j = JSON.parse(raw);
      message = j.error?.message || j.message || raw;
    } catch {
      message = raw;
    }
  } catch {
    /* ignore */
  }
  const hint =
    [401, 403, 404, 429].includes(res.status) ? tr(`http${res.status}`) : '';
  const err = new Error(tr('httpError', `${res.status}${hint}`, (message || res.statusText).slice(0, 300)));
  err.status = res.status;
  err.detail = raw.slice(0, 4000); // e.g. Gemini quota ids (PerDay / PerMinute)
  return err;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

/** Minimal Server-Sent Events parser over a fetch Response body. */
async function* sseEvents(res) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const parse = (raw) => {
    let event = 'message';
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? { event, data: data.join('\n') } : null;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const ev = parse(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
      if (ev) yield ev;
    }
  }
  const tail = parse(buf);
  if (tail) yield tail;
}
