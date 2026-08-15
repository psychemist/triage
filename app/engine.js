/* Triage engine — cleaning, classification */
(function (root) {
  "use strict";

  /* ---------------- signal catalog ----------------
   * The single source of truth for qualification signals. */

  const GATES = {
    "spam":              [/won \$/, /click here to claim/, /smm panel/, /buy followers/, /backlinks/, /bulk email blasting/, /offshore dev/, /dm for rates/],
    "job seeker":        [/looking for a role/, /attaching my cv/, /are you hiring/, /join your team/],
    "recruiter":         [/place candidates/, /devs on our bench/],
    "student / learner": [/\bstudent\b/, /bootcamp grad/, /university project/, /free (template|material|resources)/, /just learning/],
    "press / VC":        [/journalist/, /looking for a quote/, /\bvc here\b/, /not a (direct )?buyer/],
    "competitor":        [/competing automation agency/, /benchmark/, /fellow agency owner/, /researching the market/, /we do similar work/],
    "test row":          [/test entry/, /test test ignore/, /newsletter signup/],
    "low budget":    [/can't really pay/, /tiny budget/, /budget way below range/],
  };

  const SIGNALS = {
    budget_approved:      { pts: 20,  label: "budget approved",       re: /budget approved/ },
    urgent_timeline:      { pts: 18,  label: "urgent timeline",       re: /asap|move fast|start this month|decision this month|pilot in the next|in \d+ weeks|priority for the quarter/ },
    acute_pain:           { pts: 15,  label: "acute pain named",      re: /eating our week/ },
    wants_full_automation:{ pts: 12,  label: "wants full automation", re: /end to end/ },
    decision_maker:       { pts: 10,  label: "decision-maker",        re: /decision is mine|i make the call|my priority to solve/ },
    active_evaluation:    { pts: 8,   label: "active evaluation",     re: /comparing a few options/ },
    decision_month:       { pts: 6,   label: "decision ~1 month",     re: /decision in about a month/ },
    has_some_budget:      { pts: 5,   label: "has some budget",       re: /have some budget|budgeted/ },
    named_workflow:       { pts: 4,   label: "named a workflow",      re: /automat/ },
    no_clear_authority:   { pts: -1,  label: "no clear authority",    re: /who signs off|loop in the team/ },
    budget_not_committed: { pts: -2,  label: "budget not committed",  re: /budget not locked|won'?t share budget|wont share budget|no real budget/ },
    price_sensitive:      { pts: -4,  label: "price sensitive",       re: /price sensitive/ },
    vague_scope:          { pts: -6,  label: "vague on scope",        re: /not totally sure what we need|vague on scope|not sure what we need/ },
    deferred_interest:    { pts: -10, label: "deferred interest",     re: /maybe later/ },
  };

  /* Regex detector
   * Returns { category, signals: [names] }; category "prospect" means scoreable. */
  function detectSignals(notes) {
    for (const [category, pats] of Object.entries(GATES)) {
      if (pats.some(p => p.test(notes))) return { category, signals: [] };
    }
    return {
      category: "prospect",
      signals: Object.keys(SIGNALS).filter(k => SIGNALS[k].re.test(notes)),
    };
  }

  /* ---------------- fit signals (0–40) ---------------- */

  const SENIORITY = {
    "owner": 10, "founder": 10, "ceo": 10, "coo": 10, "managing director": 10,
    "managing partner": 10, "partner": 8, "cto": 8, "vp growth": 8, "vp ops": 8,
    "head of ops": 8, "head of growth": 8, "head of revops": 8, "director of ops": 6,
    "director of growth": 6, "director of revops": 6, "marketing manager": 4,
    "consultant": 2, "freelancer": 0, "developer": -5, "student": -10, "recruiter": -10,
  };
  const SOURCE_PTS = { referral: 8, event: 5, linkedin: 4, webform: 2, "cold reply": 1 };
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

  /* ---------------- field cleaning ---------------- */

  function cleanEmail(s) {
    const e = (s || "").trim().toLowerCase().replace(/\[at\]/g, "@").replace(/\s+/g, "");
    return EMAIL_RE.test(e) ? e : null;
  }

  function parseBudget(s) {
    const raw = (s || "").trim().toLowerCase();
    if (!raw || ["n/a", "na", "-"].includes(raw)) return [null, "none"];
    if (["tbd", "depends", "unknown", "?"].includes(raw)) return [null, "tbd"];
    const t = raw.replace(/\$/g, "").replace(/\/mo/g, "").replace(/per month/g, "").replace(/,/g, "").trim();
    let m = t.match(/^(\d+(?:\.\d+)?)k?\s*[-–]\s*(\d+(?:\.\d+)?)(k?)$/);
    if (m) {
      let lo = +m[1], hi = +m[2];
      if (m[3] === "k" || hi < 100) { lo *= 1000; hi *= 1000; }
      return [(lo + hi) / 2, "known"];
    }
    m = t.match(/^(\d+(?:\.\d+)?)(k?)$/);
    if (m) {
      const v = +m[1] * (m[2] === "k" ? 1000 : 1);
      return v === 0 ? [v, "zero"] : [v, "known"];
    }
    return [null, "none"];
  }

  function parseEmployees(s) {
    const t = (s || "").trim().toLowerCase().replace(/[~+]/g, "");
    if (!/\d/.test(t)) return null;
    let m = t.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (m) return Math.floor((+m[1] + +m[2]) / 2);
    m = t.match(/^(\d+)$/);
    return m ? +m[1] : null;
  }

  /* ---------------- scoring ---------------- */
  /* Reasons are structured: { pts, label, group } — group is "intent" | "fit" | "gate".
   * pts === null means an informational flag with no numeric weight. */

  /* Score a lead from a detection result ({category, signals}) — the shared
   * back half used by both detectors. `via` tags reasons with their detector. */
  function scoreFromDetection(lead, detection, via) {
    const notes = (lead.notes || "").toLowerCase();
    const tag = via === "ai" ? " (AI)" : "";

    if (detection.category !== "prospect")
      return { score: 0, intent: 0, fit: 0, tier: "DISQUALIFY", category: detection.category,
               reasons: [{ pts: null, label: "hard disqualifier: " + detection.category + tag, group: "gate" }] };
    if (!notes.trim())
      return { score: 0, intent: 0, fit: 0, tier: "DISQUALIFY", category: "no information",
               reasons: [{ pts: null, label: "empty notes — nothing to qualify on", group: "gate" }] };

    const reasons = [];
    let intent = 0;
    for (const name of detection.signals) {
      const s = SIGNALS[name];
      if (!s) continue;
      intent += s.pts;
      reasons.push({ pts: s.pts, label: s.label + tag, group: "intent" });
    }
    intent = Math.max(0, Math.min(60, intent));

    let fit = 0;
    if (lead.budgetStatus === "known") {
      const b = lead.budget;
      const pts = b >= 8000 ? 15 : b >= 5000 ? 12 : b >= 2000 ? 6 : -5;
      fit += pts; reasons.push({ pts, label: `budget ~$${Math.round(b).toLocaleString()}/mo`, group: "fit" });
    } else if (lead.budgetStatus === "zero") {
      fit -= 8; reasons.push({ pts: -8, label: "budget listed as 0", group: "fit" });
    }
    if (lead.employees != null) {
      const e = lead.employees;
      const pts = (e >= 10 && e <= 120) ? 8 : (e >= 3 && e < 10) ? 4 : -2;
      fit += pts; reasons.push({ pts, label: `team size ${e}`, group: "fit" });
    }
    const t = (lead.title || "").trim().toLowerCase();
    if (t in SENIORITY && SENIORITY[t]) { fit += SENIORITY[t]; reasons.push({ pts: SENIORITY[t], label: `title: ${lead.title}`, group: "fit" }); }
    const s = (lead.source || "").trim().toLowerCase();
    if (SOURCE_PTS[s]) { fit += SOURCE_PTS[s]; reasons.push({ pts: SOURCE_PTS[s], label: `source: ${s}`, group: "fit" }); }
    if (/agency|agencies/.test(notes) || /agency|agencies/.test((lead.company || "").toLowerCase())) {
      fit += 5; reasons.push({ pts: 5, label: "agency (core ICP)", group: "fit" });
    }
    fit = Math.max(0, Math.min(40, fit));

    const score = intent + fit;
    if (!lead.email) reasons.push({ pts: null, label: "no valid e-mail — capped at Nurture until fixed", group: "gate" });
    const tier = (score >= 60 && lead.email) ? "CONTACT_NOW" : score >= 14 ? "NURTURE" : "DISQUALIFY";
    const category = tier === "DISQUALIFY" ? "low intent / poor fit" : "prospect";
    return { score, intent, fit, tier, category, reasons };
  }

  function scoreLead(lead) {
    return scoreFromDetection(lead, detectSignals((lead.notes || "").toLowerCase()), "regex");
  }

  /* Re-score already-cleaned leads with external detections (the AI path).
   * `detections[i]` pairs with `leads[i]`; missing entries keep the regex result. */
  function rescoreWithDetections(leads, detections) {
    leads.forEach((lead, i) => {
      if (detections[i]) Object.assign(lead, scoreFromDetection(lead, detections[i], "ai"));
    });
    const order = { CONTACT_NOW: 0, NURTURE: 1, DISQUALIFY: 2 };
    leads.sort((a, b) => order[a.tier] - order[b.tier] || b.score - a.score);
    leads.forEach((l, i) => l.rank = i + 1);
    return leads;
  }

  /* ---------------- CSV parsing + column auto-detection ---------------- */

  function parseCSV(text) {
    const rows = []; let row = [], field = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some(f => f.trim() !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); if (row.some(f => f.trim() !== "")) rows.push(row); }
    const header = rows.shift().map(h => h.trim().toLowerCase());
    return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
  }

  const COLMAP = {
    lead_id: ["lead_id", "id", "lead id"], created: ["created", "date", "created_at"],
    name: ["name", "full name", "contact"], email: ["email", "e-mail", "email address"],
    company: ["company", "organisation", "organization"], employees: ["employees", "team size", "headcount", "size"],
    website: ["website", "url", "domain"], title: ["title", "role", "job title"],
    source: ["source", "channel", "lead source"], monthly_budget: ["monthly_budget", "budget", "monthly budget"],
    notes: ["notes", "note", "comments", "message"],
  };

  function mapColumns(raw) {
    return raw.map(r => {
      const o = {};
      for (const [canon, aliases] of Object.entries(COLMAP)) {
        o[canon] = "";
        for (const a of aliases) if (a in r) { o[canon] = r[a]; break; }
      }
      return o;
    });
  }

  /* ---------------- pipeline ---------------- */

  function runPipeline(rawRows) {
    const rows = mapColumns(rawRows);
    const dropped = { junk: 0, dupes: 0 };
    const seenEmails = new Set(), seenSigs = new Set(), leads = [];
    for (const r of rows) {
      const all = Object.values(r).join(" ").toLowerCase();
      if (["header", "lead_id"].includes(r.lead_id) || (r.source || "").toLowerCase().includes("test") ||
          ["asdf", "test user"].includes((r.name || "").toLowerCase()) || r.title === "title") { dropped.junk++; continue; }
      const email = cleanEmail(r.email);
      const sig = email || ((r.name || "").toLowerCase().trim() + "|" + (r.company || "").toLowerCase().trim());
      if (all.includes("(duplicate submission)") || (email && seenEmails.has(email)) || (!email && seenSigs.has(sig))) {
        dropped.dupes++; continue;
      }
      if (email) seenEmails.add(email);
      seenSigs.add(sig);
      const [budget, budgetStatus] = parseBudget(r.monthly_budget);
      const lead = {
        leadId: (r.lead_id || "").trim(), name: (r.name || "").trim(),
        emailRaw: (r.email || "").trim(), email,
        company: (r.company || "").trim(), employees: parseEmployees(r.employees),
        title: (r.title || "").trim(), source: (r.source || "").trim().toLowerCase(),
        budget, budgetStatus, notes: (r.notes || "").trim(),
      };
      Object.assign(lead, scoreLead(lead));
      leads.push(lead);
    }
    const order = { CONTACT_NOW: 0, NURTURE: 1, DISQUALIFY: 2 };
    leads.sort((a, b) => order[a.tier] - order[b.tier] || b.score - a.score);
    leads.forEach((l, i) => l.rank = i + 1);
    return { leads, dropped, inputRows: rows.length };
  }

  function reasonText(r) {
    return r.pts === null ? r.label : `${r.pts >= 0 ? "+" : ""}${r.pts} ${r.label}`;
  }

  function toCSV(leads) {
    const head = ["rank", "tier", "score", "lead_id", "name", "email", "company", "title", "employees", "budget_usd_est", "source", "reasons", "notes"];
    const q = v => { v = (v ?? "").toString(); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return [head.join(",")].concat(leads.map(l => [
      l.rank, l.tier, l.score, l.leadId, l.name, l.email || `INVALID(${l.emailRaw})`, l.company, l.title,
      l.employees ?? "", l.budget ? Math.round(l.budget) : "", l.source,
      l.reasons.map(reasonText).join("; "), l.notes,
    ].map(q).join(","))).join("\n");
  }

  const api = { runPipeline, parseCSV, scoreLead, toCSV, reasonText,
                detectSignals, scoreFromDetection, rescoreWithDetections,
                SIGNALS, GATE_NAMES: Object.keys(GATES) };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TriageEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
