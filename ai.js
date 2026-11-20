// ============================================================================
// ASB PIPELINE — ai.js
//
// One small door to an AI model, for reading typed orders (typedorder.js).
// The same providers the bhao bot supports. Keys live ONLY in Render's
// environment; they are never logged, returned or sent anywhere but the
// provider's own API host.
//
//   ORDER_AI_PROVIDER = groq | xai | anthropic | openai   (default: groq)
//   GROQ_API_KEY + GROQ_MODEL / XAI_API_KEY + XAI_MODEL / ANTHROPIC_API_KEY + ANTHROPIC_MODEL / OPENAI_API_KEY + OPENAI_MODEL
//   ORDER_AI_TIMEOUT_MS (default 12000), ORDER_AI_REASONING_EFFORT (reasoning models; default low)
// ============================================================================
"use strict";

const PROVIDERS = Object.freeze({
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", keyVar: "GROQ_API_KEY", modelVar: "GROQ_MODEL", shape: "openai" },
  xai: { url: "https://api.x.ai/v1/chat/completions", keyVar: "XAI_API_KEY", modelVar: "XAI_MODEL", shape: "openai" },
  anthropic: { url: "https://api.anthropic.com/v1/messages", keyVar: "ANTHROPIC_API_KEY", modelVar: "ANTHROPIC_MODEL", shape: "anthropic" },
  // OpenAI's current models are reasoning models: no temperature, max_completion_tokens instead of max_tokens
  openai: { url: "https://api.openai.com/v1/chat/completions", keyVar: "OPENAI_API_KEY", modelVar: "OPENAI_MODEL", shape: "openai", reasoningApi: true },
});

function providerName(env = process.env) {
  const n = String(env.ORDER_AI_PROVIDER || "groq").toLowerCase();
  return PROVIDERS[n] ? n : null;
}
function configured(env = process.env) {
  const n = providerName(env);
  return Boolean(n && env[PROVIDERS[n].keyVar] && env[PROVIDERS[n].modelVar]);
}

/** One request, and ONE retry when the provider says "too many, try in a few seconds". */
async function complete(args) {
  try {
    return await completeOnce(args);
  } catch (e) {
    if (e.code === "provider_error_429" && e.retryAfter != null && e.retryAfter <= 6) {
      await new Promise((r) => setTimeout(r, Math.max(1, e.retryAfter) * 1000));
      return completeOnce(args);
    }
    throw e;
  }
}

/** One request; returns the model's text. Throws {code} on any failure. */
async function completeOnce({ system, user, env = process.env, fetchImpl = fetch, maxTokens = 900 }) {
  const name = providerName(env);
  if (!name) throw Object.assign(new Error("unknown provider"), { code: "not_configured" });
  const p = PROVIDERS[name];
  const key = env[p.keyVar], model = env[p.modelVar];
  if (!key || !model) throw Object.assign(new Error("not configured"), { code: "not_configured" });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Number(env.ORDER_AI_TIMEOUT_MS) > 0 ? Number(env.ORDER_AI_TIMEOUT_MS) : 12000);
  try {
    let res, body;
    if (p.shape === "openai") {
      res = await fetchImpl(p.url, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        // Reasoning models (gpt-oss on Groq) think before they write: room for
        // that, and low effort by default - reading an order is not hard.
        body: JSON.stringify(p.reasoningApi
          ? { model, max_completion_tokens: Math.max(maxTokens, 3000), reasoning_effort: env.ORDER_AI_REASONING_EFFORT || "low",
              messages: [{ role: "system", content: system }, { role: "user", content: user }] }
          : { model, temperature: 0, max_tokens: Math.max(maxTokens, 3000),
              ...(/gpt-oss|qwen3|reason/i.test(model) ? { reasoning_effort: env.ORDER_AI_REASONING_EFFORT || "low" } : {}),
              messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
      body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // say WHICH limit (tokens per minute / per day): the difference decides what to do about it
        console.error(`[order-ai] ${name} ${res.status}: ${String(body?.error?.message || "").slice(0, 300)}`);
        throw Object.assign(new Error("provider status " + res.status), {
          code: "provider_error_" + res.status, retryAfter: Number(res.headers?.get?.("retry-after")) || null });
      }
      return String(body?.choices?.[0]?.message?.content ?? "");
    }
    res = await fetchImpl(p.url, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: Math.max(maxTokens, 1500), temperature: 0, system, messages: [{ role: "user", content: user }] }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error("provider status " + res.status), { code: "provider_error_" + res.status });
    return (body?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  } catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error("timeout"), { code: "timeout" });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { PROVIDERS, providerName, configured, complete };
