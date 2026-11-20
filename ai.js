// ============================================================================
// ASB PIPELINE — ai.js
//
// One small door to an AI model, for reading typed orders (typedorder.js).
// The same providers the bhao bot supports. Keys live ONLY in Render's
// environment; they are never logged, returned or sent anywhere but the
// provider's own API host.
//
//   ORDER_AI_PROVIDER = groq | xai | anthropic   (default: groq)
//   GROQ_API_KEY + GROQ_MODEL / XAI_API_KEY + XAI_MODEL / ANTHROPIC_API_KEY + ANTHROPIC_MODEL
//   ORDER_AI_TIMEOUT_MS (default 12000)
// ============================================================================
"use strict";

const PROVIDERS = Object.freeze({
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", keyVar: "GROQ_API_KEY", modelVar: "GROQ_MODEL", shape: "openai" },
  xai: { url: "https://api.x.ai/v1/chat/completions", keyVar: "XAI_API_KEY", modelVar: "XAI_MODEL", shape: "openai" },
  anthropic: { url: "https://api.anthropic.com/v1/messages", keyVar: "ANTHROPIC_API_KEY", modelVar: "ANTHROPIC_MODEL", shape: "anthropic" },
});

function providerName(env = process.env) {
  const n = String(env.ORDER_AI_PROVIDER || "groq").toLowerCase();
  return PROVIDERS[n] ? n : null;
}
function configured(env = process.env) {
  const n = providerName(env);
  return Boolean(n && env[PROVIDERS[n].keyVar] && env[PROVIDERS[n].modelVar]);
}

/** One request; returns the model's text. Throws {code} on any failure. */
async function complete({ system, user, env = process.env, fetchImpl = fetch, maxTokens = 900 }) {
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
        body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens,
          messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error("provider status " + res.status), { code: "provider_error_" + res.status });
      return String(body?.choices?.[0]?.message?.content ?? "");
    }
    res = await fetchImpl(p.url, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: "user", content: user }] }),
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
