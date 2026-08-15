/* Triage — optional AI signal detection.
 *
 * Swaps the regex detector for an open-model classifier — NVIDIA's Nemotron 3
 * (open weights): the model reads each lead's notes and returns which of the
 * engine's named signals are present. Scoring, weights, tiers, and
 * explanations stay in engine.js unchanged.
 *
 * The API key picks the route (kept in memory for the session only; never
 * stored or sent anywhere else):
 *   sk-or-…  OpenRouter — CORS-open, called straight from the browser; works
 *            self-hosted, on static hosts, or from a local file.
 *   nvapi-…  NVIDIA's own API (build.nvidia.com) — blocks browser CORS, so
 *            calls go through the same-origin /nim/ proxy that the Docker
 *            self-host (nginx) provides.
 *
 * Both routes run on free-tier keys. The ":free" suffix is an OpenRouter
 * convention for its no-cost pool; NVIDIA's API only knows the bare slug, so
 * the suffix is stripped on that route (build.nvidia.com is free by default).
 */
(function (root) {
  "use strict";
  const E = root.TriageEngine;
  const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
  const NIM_PROXY_URL = "/nim/v1/chat/completions";
  // Long batches invite the model to truncate the list with a placeholder
  // instead of finishing it; short ones stay well inside that failure mode.
  const BATCH = 12;

  const CATEGORIES = E.GATE_NAMES.concat(["prospect"]);
  const SIGNAL_NAMES = Object.keys(E.SIGNALS);

  const SIGNAL_MEANINGS = {
    budget_approved: "budget is approved/committed, or they clearly have sign-off on spend",
    urgent_timeline: "wants to start now/ASAP, decision this month, pilot in weeks, priority this quarter",
    acute_pain: "names a concrete painful manual workflow that is costing them real time",
    wants_full_automation: "wants the workflow automated end to end, not just advice",
    decision_maker: "the writer personally owns the decision",
    active_evaluation: "actively comparing vendors/options right now",
    decision_month: "decision expected in roughly a month",
    has_some_budget: "some budget exists or is earmarked, though not fully committed",
    named_workflow: "describes a specific workflow they want automated",
    no_budget: "no real budget / can't pay / tiny budget",
    deferred_interest: "interested but explicitly deferring (maybe later)",
    price_sensitive: "emphasizes price sensitivity",
    budget_not_committed: "budget unlocked/undisclosed/contingent",
    no_clear_authority: "unclear who signs off, or needs to loop in others to decide",
    vague_scope: "doesn't know what they need; vague on scope",
  };

  const SYSTEM = `/no_think

You classify inbound sales leads for an AI-automation agency whose core customers are marketing/growth agencies. For each numbered note, decide:

1. "category" — exactly one of:
${E.GATE_NAMES.map(g => `   - "${g}": clearly not a buyer of this kind`).join("\n")}
   - "prospect": a potential buyer (any genuine commercial interest, even weak)
   Only use a non-prospect category when the note clearly fits it. When unsure, use "prospect".

2. "signals" — for prospects only, every signal genuinely supported by the note's meaning (not just literal phrasing). For non-prospects return []. Signals:
${SIGNAL_NAMES.map(k => `   - "${k}": ${SIGNAL_MEANINGS[k]}`).join("\n")}

Return one result per input, with "index" echoing the input's number. Reply with a single JSON object shaped {"results": [{"index": 0, "category": "...", "signals": ["..."]}, …]} — no prose, no code fences.`;

  const SCHEMA = {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            category: { type: "string", enum: CATEGORIES },
            signals: { type: "array", items: { type: "string", enum: SIGNAL_NAMES } },
          },
          required: ["index", "category", "signals"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  };

  function routeFor(apiKey) {
    return apiKey.startsWith("nvapi-")
      ? { url: NIM_PROXY_URL, nim: true }
      : { url: OPENROUTER_URL, nim: false };
  }

  /* ---------------- response parsing ----------------
   * Open models don't always honor the schema: they wrap output in <think>
   * blocks or code fences, and over a long batch some get lazy and write a
   * placeholder ("…, ... etc. ]") instead of finishing the list. A single
   * whole-document JSON.parse turns any of that into a total loss for all
   * notes in the batch, so parsing is salvage-based: take the clean parse when
   * it works, otherwise recover every individual result object that is valid.
   * Whatever is missing simply keeps its regex result downstream. */

  const CATEGORY_SET = new Set(CATEGORIES);
  const SIGNAL_SET = new Set(SIGNAL_NAMES);

  function isResult(o) {
    return o && typeof o === "object" && Number.isInteger(o.index) && typeof o.category === "string";
  }

  /* Normalize one model result, dropping anything the catalog doesn't define. */
  function cleanResult(o) {
    return {
      index: o.index,
      category: CATEGORY_SET.has(o.category) ? o.category : "prospect",
      signals: Array.isArray(o.signals) ? o.signals.filter(s => SIGNAL_SET.has(s)) : [],
    };
  }

  /* Index of the `}` closing the `{` at `start`, or -1 if unterminated. */
  function matchBrace(s, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return i;
    }
    return -1;
  }

  function extractResults(text) {
    const cleaned = text
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/<think>[\s\S]*$/, "");          // unterminated reasoning block

    const first = cleaned.indexOf("{");
    if (first < 0) return [];

    // Fast path: the whole document parses (schema was honored).
    try {
      const whole = JSON.parse(cleaned.slice(first, cleaned.lastIndexOf("}") + 1));
      if (Array.isArray(whole.results)) return whole.results.filter(isResult).map(cleanResult);
    } catch { /* fall through to salvage */ }

    // Salvage: recover each well-formed object, skipping prose and truncation.
    const out = [];
    for (let i = first; i >= 0; i = cleaned.indexOf("{", i + 1)) {
      const end = matchBrace(cleaned, i);
      if (end < 0) continue;                     // unterminated here (e.g. the cut-off wrapper) — try the next object
      let obj;
      try { obj = JSON.parse(cleaned.slice(i, end + 1)); } catch { continue; }
      if (Array.isArray(obj.results)) { out.push(...obj.results.filter(isResult).map(cleanResult)); i = end; }
      else if (isResult(obj)) { out.push(cleanResult(obj)); i = end; }
    }
    return out;
  }

  /* `noSchema` re-runs without the structured-output request, for the rare
   * provider that rejects the parameter outright instead of ignoring it. */
  async function classifyBatch(apiKey, model, batch, attempt = 0, noSchema = false) {
    const route = routeFor(apiKey);
    const bare = model.replace(/:free$/, "");
    const body = {
      model: route.nim ? bare : model,
      max_tokens: 8000,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: batch.map(b => `${b.index}. ${b.notes || "(empty)"}`).join("\n") },
      ],
    };
    // Ask for guided decoding on every model: NVIDIA's NIM enforces it for
    // everything it serves, and OpenRouter ignores the parameter where the
    // provider can't honor it — so requesting it can only help.
    if (route.nim) body.nvext = { guided_json: SCHEMA };
    else if (!noSchema)
      body.response_format = { type: "json_schema", json_schema: { name: "triage_results", strict: true, schema: SCHEMA } };

    let res;
    try {
      res = await fetch(route.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(route.nim
        ? "Could not reach the /nim/ proxy. NVIDIA keys (nvapi-…) need the Docker self-host (docker compose up), which proxies NVIDIA's CORS-blocked API — or use an OpenRouter key (sk-or-…), which works from anywhere."
        : "Could not reach openrouter.ai. If you're viewing the hosted demo: it blocks external requests by design — run the self-hosted or local version for AI mode. Otherwise check your connection.");
    }
    if (route.nim && res.status === 404)
      throw new Error("This server has no /nim/ proxy, so NVIDIA keys (nvapi-…) won't work here. Use the Docker self-host (docker compose up) — or an OpenRouter key (sk-or-…), which works from anywhere.");
    if (res.status === 401 || res.status === 403)
      throw new Error(`API key rejected (${res.status}). Check the key and try again.`);
    if (res.status === 429) {
      if (attempt < 3) {
        const wait = (parseInt(res.headers.get("retry-after"), 10) || 15) * 1000;
        await new Promise(r => setTimeout(r, wait));
        return classifyBatch(apiKey, model, batch, attempt + 1);
      }
      throw new Error("Rate limited (429) after 3 retries — free tiers cap requests per minute and per day. Wait a few minutes and re-run, or switch to a paid model slug (drop the \":free\" suffix).");
    }
    if (res.status >= 500 && attempt < 2) {
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
      return classifyBatch(apiKey, model, batch, attempt + 1);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      const msg = err?.error?.message || err?.detail || res.statusText;
      // Some providers reject response_format rather than ignoring it — drop it and retry once.
      if (res.status === 400 && !noSchema && /response_format|json_schema|structured/i.test(msg || ""))
        return classifyBatch(apiKey, model, batch, attempt, true);
      throw new Error(`API error ${res.status}: ${msg}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from the model.");
    return extractResults(text);
  }

  /* Classify one batch into `detections`. A model that skipped some notes gets
   * asked again for just those, in smaller chunks — laziness scales with batch
   * size, so a shorter re-ask usually lands. */
  async function classifyInto(apiKey, model, batch, detections, depth = 0) {
    const results = await classifyBatch(apiKey, model, batch);
    const got = new Set();
    for (const r of results) {
      if (r.index >= 0 && r.index < detections.length) {
        detections[r.index] = { category: r.category, signals: r.signals };
        got.add(r.index);
      }
    }
    const missing = batch.filter(b => !got.has(b.index));
    if (missing.length && batch.length > 1 && depth < 2) {
      const half = Math.ceil(missing.length / 2);
      await classifyInto(apiKey, model, missing.slice(0, half), detections, depth + 1);
      if (missing.length > half)
        await classifyInto(apiKey, model, missing.slice(half), detections, depth + 1);
    }
  }

  /* Classify every lead's notes; returns a detections array aligned with `leads`.
   * Entries left undefined keep their regex result, so a partial run still works.
   * onProgress(done, total) fires after each batch. */
  async function detectWithAI(apiKey, model, leads, onProgress) {
    const detections = new Array(leads.length);
    const items = leads.map((l, i) => ({ index: i, notes: l.notes }));
    for (let off = 0; off < items.length; off += BATCH) {
      await classifyInto(apiKey, model, items.slice(off, off + BATCH), detections);
      onProgress?.(Math.min(off + BATCH, items.length), items.length);
    }
    return detections;
  }

  root.TriageAI = { detectWithAI };
})(window);
