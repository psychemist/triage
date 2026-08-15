/* Triage engine — cleaning, classification */
(function (root) {
  "use strict";

  /* ---------------- signal catalog ----------------
   * The single source of truth for qualification signals. */

  const GATES = {
    "spam": [
      /won \$|you have won|claim your (prize|reward)|congratulations,? you/,
      /click here|limited time offer|act now|make money fast|work from home/,
      /smm panel|buy (followers|likes|traffic)|cheap traffic|social media boost/,
      /backlinks|high.?da links|guaranteed (rank|first page)|rank #?\d+ guaranteed/,
      /bulk email blasting|mass mailer|email blast service|scraped (list|leads) for sale/,
      /offshore (dev|team|developers)|dedicated developers at|staff augmentation|\$\d+\/hr/,
      /dm for rates|crypto|bitcoin|forex|lottery|inheritance|wire transfer/,
    ],
    "job seeker": [
      /looking for a (role|job|position)|seeking (a )?(role|position|employment)|open to work/,
      /attaching my (cv|resume)|my (cv|resume) is attached|resume attached|here'?s my cv/,
      /are you hiring|any (openings|vacancies)|join your team|apply for a (job|role)/,
      /hire me|available for hire|looking for work|internship/,
    ],
    "recruiter": [
      /place candidates|candidates for you|our bench|devs on (our|the) bench/,
      /staffing agency|recruiting firm|headhunt|talent pool|we supply (developers|talent)/,
    ],
    "student / learner": [
      /\bstudent\b|bootcamp grad|final year|freshman|undergrad|postgrad/,
      /university project|school project|class project|thesis|dissertation|coursework|academic research/,
      /free (template|material|materials|resources|course|guide)|any free/,
      /just learning|learning purposes|teach me|mentor me|how did you (build|make)|share how you built/,
    ],
    "press / VC": [
      /journalist|reporter|writing (an article|a piece|a story)|press inquiry|media inquiry/,
      /looking for a quote|for our publication|blog post about|feature you|on our podcast/,
      /\bvc here\b|venture capital|angel investor|portfolio compan|due diligence/,
      /not a (direct )?buyer|not a client|not looking to buy/,
    ],
    "competitor": [
      /competing (automation )?agency|competitor|rival agency|we run a similar|also an automation agency/,
      /benchmark|fellow agency owner|researching the market|market research|scoping the competition/,
      /we do similar work|we offer the same|curious how you price for comparison/,
    ],
    "test row": [
      /test entry|test test|qa test|please ignore|ignore this|dummy (data|entry|row)/,
      /sample row|placeholder|lorem ipsum|^\s*(test|asdf|xxx)\s*$/,
      /newsletter signup|mailing list signup|subscribed by mistake/,
    ],
    "low budget": [
      /can'?t really pay|can ?not afford|can'?t afford|too expensive for us/,
      /tiny budget|shoestring|no budget at all|zero budget|budget way below range/,
      /out of our (price )?range|below our range|way out of budget/,
      /looking for (something )?free|free (option|version|tier|plan)|pro bono|only if it'?s free/,
    ],
  };

  const SIGNALS = {
    budget_approved: { pts: 20, label: "budget approved", re:
      /budget (is )?approved|approved budget|budget (secured|confirmed|in place|allocated)|allocated budget|we have the budget|funding (is )?approved|signed off on (the )?budget|sign.?off on (spend|budget)|have sign.?off/ },
    urgent_timeline: { pts: 18, label: "urgent timeline", re:
      /asap|urgent|right away|immediately|move fast|moving fast|start (this|next) month|start now|decision this month|pilot in the next|in \d+ weeks|priority for the quarter|this quarter|time.sensitive|need this (done )?(by|before)|kick.?off (this|next) month/ },
    acute_pain: { pts: 15, label: "acute pain named", re:
      /eating (up )?(our|the) (week|time|days|hours)|wasting (hours|time|days)|burning (hours|time)|takes (us )?(hours|days)|too much time|time.consuming|tedious|manual(ly)?.{0,25}(every|each) (day|week)|drowning in|swamped|bottleneck|can'?t keep up|falling behind|nightmare|painful/ },
    wants_full_automation: { pts: 12, label: "wants full automation", re:
      /end.to.end|fully automated?|full automation|completely automated?|hands.off|automate the whole|entire (process|workflow)|from start to finish|without (any )?manual|no manual/ },
    decision_maker: { pts: 10, label: "decision-maker", re:
      /decision is mine|i make the call|my priority to solve|my decision|i decide|i sign off|i can approve|final say|i own (this|the budget)|i'?m the (owner|founder|ceo|decision.maker)/ },
    active_evaluation: { pts: 8, label: "active evaluation", re:
      /comparing (a few |several |multiple )?(options|vendors|tools|providers|solutions)|evaluating (a few|several|options|vendors|tools)|shortlist|looking at alternatives|getting quotes|\brfp\b|request for proposal|in talks with|demos? with/ },
    decision_month: { pts: 6, label: "decision ~1 month", re:
      /decision (in|within) (about )?a (month|few weeks)|deciding (this|next) month|decide (in|within).{0,12}(month|weeks)|timeline is.{0,15}month/ },
    has_some_budget: { pts: 5, label: "has some budget", re:
      /have some budget|some budget|budgeted|budget exists|funds available|money set aside|allocated some/ },
    named_workflow: { pts: 4, label: "named a workflow", re:
      /automat|streamline|workflow|manual process|copy.?past|data entry|integrat|sync (between|with)/ },
    no_clear_authority: { pts: -1, label: "no clear authority", re:
      /who signs off|loop in the team|need to (check|ask|run it by|consult)|not sure who (decides|signs)|team decision|committee|get approval|internal buy.?in|my (boss|manager|partner) (would|will|needs)/ },
    budget_not_committed: { pts: -2, label: "budget not committed", re:
      /budget not locked|won'?t share budget|wont share budget|depends what you can do|budget (is )?tbd|haven'?t (set|decided).{0,12}budget|budget (undecided|not set|not decided)|need to figure out budget/ },
    price_sensitive: { pts: -4, label: "price sensitive", re:
      /price.sensitive|cost.conscious|cheapest|lowest price|budget.friendly|what do you charge|how much (does it|do you) cost|discount|negotiate on price/ },
    vague_scope: { pts: -6, label: "vague on scope", re:
      /not totally sure what we need|not sure what (we need|exactly)|vague on scope|don'?t know what we (need|want)|still figuring (it )?out|just exploring|not sure where to start|open to ideas|early research/ },
    deferred_interest: { pts: -10, label: "deferred interest", re:
      /maybe later|later this year|next year|not right now|not at the moment|circle back|revisit (in|next|later)|touch base (in|later)|down the (road|line)|in a few months|keep me posted/ },
  };

  const NURTURE_FLOOR = [
    /early.stage|early startup|very early|early days|just (got )?started|starting out|new (agency|business)/,
    /pre.?revenue|pre.?seed|bootstrapp?ed|no real budget yet|budget (next|by next) (quarter|year)/,
    /might grow|but sharp|small but growing|growing fast|scaling up|plan to scale/,
    /too early (for us|right now)|not ready (yet|to buy)|revisit when we (grow|scale)/,
  ];

  const RESCUABLE_GATES = new Set(["low budget"]);

  function hasNurtureFloor(notes) {
    return NURTURE_FLOOR.some(re => re.test(notes));
  }

  /* Regex detector
   * Returns { category, signals: [names] }; category "prospect" means scoreable. */
  function detectSignals(notes) {
    for (const [category, pats] of Object.entries(GATES)) {
      if (pats.some(p => p.test(notes))) {
        if (RESCUABLE_GATES.has(category) && hasNurtureFloor(notes)) continue;
        return { category, signals: [] };
      }
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
    "operations manager": 4, "growth manager": 4, "revops manager": 4,
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

  /* Score a lead from a detection result ({category, signals}). */
  function scoreFromDetection(lead, detection) {
    const notes = (lead.notes || "").toLowerCase();

    const rescued = detection.category !== "prospect"
      && RESCUABLE_GATES.has(detection.category) && hasNurtureFloor(notes);
    if (detection.category !== "prospect" && !rescued)
      return { score: 0, intent: 0, fit: 0, tier: "DISQUALIFY", category: detection.category,
               reasons: [{ pts: null, label: "hard disqualifier: " + detection.category, group: "gate" }] };
    if (!notes.trim())
      return { score: 0, intent: 0, fit: 0, tier: "DISQUALIFY", category: "no information",
               reasons: [{ pts: null, label: "empty notes — nothing to qualify on", group: "gate" }] };

    const reasons = [];
    let intent = 0;
    for (const name of detection.signals) {
      const s = SIGNALS[name];
      if (!s) continue;
      intent += s.pts;
      reasons.push({ pts: s.pts, label: s.label, group: "intent" });
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

    const floored = hasNurtureFloor(notes);
    if (floored && score < 14)
      reasons.push({ pts: null, label: "early-stage — kept for nurture rather than disqualified", group: "gate" });
    const tier = (score >= 60 && lead.email) ? "CONTACT_NOW"
               : (score >= 14 || floored)    ? "NURTURE"
               : "DISQUALIFY";
    const category = tier === "DISQUALIFY" ? "low intent / poor fit" : "prospect";
    return { score, intent, fit, tier, category, reasons };
  }

  function scoreLead(lead) {
    return scoreFromDetection(lead, detectSignals((lead.notes || "").toLowerCase()));
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
                detectSignals, scoreFromDetection,
                SIGNALS, GATE_NAMES: Object.keys(GATES) };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TriageEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
