#!/usr/bin/env python3
"""
Lead Triage — automated lead qualification pipeline (CLI).

Usage:
    python3 triage.py <leads.csv> [-o out_dir] [--ai] [--model MODEL]

Reads a raw lead export (messy is fine), cleans + dedupes it, scores every
lead on Intent (what the notes say) and Fit (who the lead is), and writes:
    - triaged_leads.csv   ranked list with score, tier, and reasons
    - summary.json        counts + run metadata

Detection has two interchangeable layers:
    default   regex patterns mined from known phrasings (free, instant)
    --ai      an open model (NVIDIA Nemotron 3) reads every note and reports
              the same named signals, so paraphrases count too. No SDK needed,
              and it runs on a free-tier key: set NVIDIA_API_KEY (nvapi-…,
              free at build.nvidia.com) or OPENROUTER_API_KEY (sk-or-…, free
              at openrouter.ai/keys).
Scoring weights and tiers are identical either way.

Tiers: CONTACT_NOW / NURTURE / DISQUALIFY
"""
import csv, json, re, sys, argparse, collections, os, time
from datetime import datetime

# ---------------------------------------------------------------- cleaning

DATE_FORMATS = ["%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%d-%m-%Y", "%b %d %Y", "%d %b %Y"]

def parse_date(s):
    s = (s or "").strip()
    if not s:
        return None
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", s)
    if m:
        return datetime(int(m[1]), int(m[2]), int(m[3])).date()
    for f in DATE_FORMATS:
        try:
            return datetime.strptime(s, f).date()
        except ValueError:
            pass
    return None

def parse_budget(s):
    raw = (s or "").strip().lower()
    if raw in ("", "n/a", "na", "-"):
        return None, "none"
    if raw in ("tbd", "depends", "unknown", "?"):
        return None, "tbd"
    t = raw.replace("$", "").replace("/mo", "").replace("per month", "").replace(",", "").strip()
    m = re.match(r"^(\d+(?:\.\d+)?)k?\s*[-–]\s*(\d+(?:\.\d+)?)(k?)$", t)
    if m:
        lo, hi = float(m[1]), float(m[2])
        if m[3] == "k" or hi < 100:
            lo, hi = lo * 1000, hi * 1000
        return (lo + hi) / 2, "known"
    m = re.match(r"^(\d+(?:\.\d+)?)(k?)$", t)
    if m:
        v = float(m[1]) * (1000 if m[2] == "k" else 1)
        return (v, "zero") if v == 0 else (v, "known")
    return None, "none"

def parse_employees(s):
    t = (s or "").strip().lower().replace("~", "").replace("+", "")
    if not t or not re.search(r"\d", t):
        return None
    m = re.match(r"^(\d+)\s*[-–]\s*(\d+)$", t)
    if m:
        return (int(m[1]) + int(m[2])) // 2
    m = re.match(r"^(\d+)$", t)
    return int(m[1]) if m else None

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")

def clean_email(s):
    e = re.sub(r"\s+", "", (s or "").strip().lower().replace("[at]", "@"))
    return e if EMAIL_RE.match(e) else None

# ---------------------------------------------------------------- signal catalog
# Single source of truth, mirrored by the web app's engine.js. Both detectors
# (regex and AI) emit these names; scoring downstream is shared.

GATES = {
    "spam":              [r"won \$", r"click here to claim", r"smm panel", r"buy followers",
                          r"backlinks", r"bulk email blasting", r"offshore dev", r"dm for rates"],
    "job seeker":        [r"looking for a role", r"attaching my cv", r"are you hiring", r"join your team"],
    "recruiter":         [r"place candidates", r"devs on our bench"],
    "student / learner": [r"\bstudent\b", r"bootcamp grad", r"university project",
                          r"free (template|material|resources)", r"just learning"],
    "press / VC":        [r"journalist", r"looking for a quote", r"\bvc here\b", r"not a (direct )?buyer"],
    "competitor":        [r"competing automation agency", r"benchmark", r"fellow agency owner",
                          r"researching the market", r"we do similar work"],
    "test row":          [r"test entry", r"test test ignore", r"newsletter signup"],
    "low budget":        [r"can't really pay", r"tiny budget", r"budget way below range"],
}

SIGNALS = {  # name: (points, label, regex)
    "budget_approved":       (20,  "budget approved",       r"budget approved"),
    "urgent_timeline":       (18,  "urgent timeline",       r"asap|move fast|start this month|decision this month|pilot in the next|in \d+ weeks|priority for the quarter"),
    "acute_pain":            (15,  "acute pain named",      r"eating our week"),
    "wants_full_automation": (12,  "wants full automation", r"end to end"),
    "decision_maker":        (10,  "decision-maker",        r"decision is mine|i make the call|my priority to solve"),
    "active_evaluation":     (8,   "active evaluation",     r"comparing a few options"),
    "decision_month":        (6,   "decision ~1 month",     r"decision in about a month"),
    "has_some_budget":       (5,   "has some budget",       r"have some budget|budgeted"),
    "named_workflow":        (4,   "named a workflow",      r"automat"),
    "no_clear_authority":    (-1,  "no clear authority",    r"who signs off|loop in the team"),
    "budget_not_committed":  (-2,  "budget not committed",  r"budget not locked|won'?t share budget|wont share budget|no real budget"),
    "price_sensitive":       (-4,  "price sensitive",       r"price sensitive"),
    "vague_scope":           (-6,  "vague on scope",        r"not totally sure what we need|vague on scope|not sure what we need"),
    "deferred_interest":     (-10, "deferred interest",     r"maybe later"),
}

SENIORITY = {
    "owner": 10, "founder": 10, "ceo": 10, "coo": 10, "managing director": 10,
    "managing partner": 10, "partner": 8, "cto": 8, "vp growth": 8, "vp ops": 8,
    "head of ops": 8, "head of growth": 8, "head of revops": 8, "director of ops": 6,
    "director of growth": 6, "director of revops": 6, "marketing manager": 4,
    "consultant": 2, "freelancer": 0, "developer": -5, "student": -10, "recruiter": -10,
}

SOURCE_PTS = {"referral": 8, "event": 5, "linkedin": 4, "webform": 2, "cold reply": 1}

def detect_signals(notes):
    """Regex detector: returns {"category": ..., "signals": [names]}."""
    for category, pats in GATES.items():
        if any(re.search(p, notes) for p in pats):
            return {"category": category, "signals": []}
    return {"category": "prospect",
            "signals": [k for k, (_, _, pat) in SIGNALS.items() if re.search(pat, notes)]}

def score_from_detection(lead, detection, via="regex"):
    """Shared scoring back half. Returns (score, intent, fit, tier, category, reasons)."""
    notes = (lead["notes"] or "").lower()
    tag = " (AI)" if via == "ai" else ""

    if detection["category"] != "prospect":
        return 0, 0, 0, "DISQUALIFY", detection["category"], [f"hard disqualifier: {detection['category']}{tag}"]
    if not notes.strip():
        return 0, 0, 0, "DISQUALIFY", "no information", ["empty notes — nothing to qualify on"]

    reasons = []
    intent = 0
    for name in detection["signals"]:
        if name not in SIGNALS:
            continue
        pts, label, _ = SIGNALS[name]
        intent += pts
        reasons.append(f"{'+' if pts >= 0 else ''}{pts} {label}{tag}")
    intent = max(0, min(60, intent))

    fit = 0
    b, bstat = lead["budget_usd"], lead["budget_status"]
    if bstat == "known":
        pts = 15 if b >= 8000 else 12 if b >= 5000 else 6 if b >= 2000 else -5
        fit += pts
        reasons.append(f"{'+' if pts >= 0 else ''}{pts} budget ~${b:,.0f}/mo")
    elif bstat == "zero":
        fit -= 8
        reasons.append("-8 budget listed as 0")

    emp = lead["employees_n"]
    if emp is not None:
        pts = 8 if 10 <= emp <= 120 else 4 if 3 <= emp < 10 else -2
        fit += pts
        reasons.append(f"{'+' if pts >= 0 else ''}{pts} team size {emp}")

    t = (lead["title"] or "").strip().lower()
    if t in SENIORITY and SENIORITY[t]:
        fit += SENIORITY[t]
        reasons.append(f"{'+' if SENIORITY[t] >= 0 else ''}{SENIORITY[t]} title: {lead['title']}")

    s = (lead["source"] or "").strip().lower()
    if s in SOURCE_PTS and SOURCE_PTS[s]:
        fit += SOURCE_PTS[s]
        reasons.append(f"+{SOURCE_PTS[s]} source: {s}")

    if re.search(r"agency|agencies", notes) or re.search(r"agency|agencies", (lead["company"] or "").lower()):
        fit += 5
        reasons.append("+5 agency (core ICP)")
    fit = max(0, min(40, fit))

    score = intent + fit
    if not lead["email_clean"]:
        reasons.append("no valid e-mail — capped at Nurture until fixed")

    if score >= 60 and lead["email_clean"]:
        tier = "CONTACT_NOW"
    elif score >= 14:
        tier = "NURTURE"
    else:
        tier = "DISQUALIFY"
    if tier == "DISQUALIFY":
        return score, intent, fit, tier, "low intent / poor fit", reasons
    return score, intent, fit, tier, "prospect", reasons

def score_lead(lead, detection=None, via="regex"):
    if detection is None:
        detection = detect_signals((lead["notes"] or "").lower())
    return score_from_detection(lead, detection, via)

# ---------------------------------------------------------------- AI detection

AI_SIGNAL_MEANINGS = {
    "budget_approved": "budget is approved/committed, or they clearly have sign-off on spend",
    "urgent_timeline": "wants to start now/ASAP, decision this month, pilot in weeks, priority this quarter",
    "acute_pain": "names a concrete painful manual workflow costing them real time",
    "wants_full_automation": "wants the workflow automated end to end, not just advice",
    "decision_maker": "the writer personally owns the decision",
    "active_evaluation": "actively comparing vendors/options right now",
    "decision_month": "decision expected in roughly a month",
    "has_some_budget": "some budget exists or is earmarked, though not fully committed",
    "named_workflow": "describes a specific workflow they want automated",
    "no_budget": "no real budget / can't pay / tiny budget",
    "deferred_interest": "interested but explicitly deferring (maybe later)",
    "price_sensitive": "emphasizes price sensitivity",
    "budget_not_committed": "budget unlocked/undisclosed/contingent",
    "no_clear_authority": "unclear who signs off, or needs to loop in others to decide",
    "vague_scope": "doesn't know what they need; vague on scope",
}

def ai_detect(leads, model, batch_size=25):
    """Classify every lead's notes with NVIDIA Nemotron; returns detections aligned with leads."""
    import urllib.request, urllib.error
    key = os.environ.get("NVIDIA_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("AI mode needs an API key: set NVIDIA_API_KEY (nvapi-…, free at "
                 "build.nvidia.com) or OPENROUTER_API_KEY (sk-or-…).")
    nim = key.startswith("nvapi-")
    url = ("https://integrate.api.nvidia.com/v1/chat/completions" if nim
           else "https://openrouter.ai/api/v1/chat/completions")
    # ":free" is OpenRouter's no-cost pool; NVIDIA's API only knows the bare slug
    bare = model.removesuffix(":free")
    if nim:
        model = bare
    # OpenRouter silently drops params a model doesn't support; only some Nemotron
    # variants advertise structured outputs. For the rest the prompt's "reply with
    # a single JSON object" plus the tolerant parse below carry the format.
    # NIM does guided decoding for every model it serves, so it skips this check.
    schema_capable = bare in {"nvidia/nemotron-3-super-120b-a12b"}

    gate_lines = "\n".join(f'   - "{g}": clearly not a buyer of this kind' for g in GATES)
    signal_lines = "\n".join(f'   - "{k}": {AI_SIGNAL_MEANINGS[k]}' for k in SIGNALS)
    system = f"""/no_think

You classify inbound sales leads for an AI-automation agency whose core customers are marketing/growth agencies. For each numbered note, decide:

1. "category" — exactly one of:
{gate_lines}
   - "prospect": a potential buyer (any genuine commercial interest, even weak)
   Only use a non-prospect category when the note clearly fits it. When unsure, use "prospect".

2. "signals" — for prospects only, every signal genuinely supported by the note's meaning (not just literal phrasing). For non-prospects return []. Signals:
{signal_lines}

Return one result per input, with "index" echoing the input's number. Reply with a single JSON object shaped {{"results": [{{"index": 0, "category": "...", "signals": ["..."]}}, ...]}} — no prose, no code fences."""

    schema = {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "index": {"type": "integer"},
                        "category": {"type": "string", "enum": list(GATES) + ["prospect"]},
                        "signals": {"type": "array", "items": {"type": "string", "enum": list(SIGNALS)}},
                    },
                    "required": ["index", "category", "signals"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["results"],
        "additionalProperties": False,
    }

    detections = [None] * len(leads)
    for off in range(0, len(leads), batch_size):
        batch = leads[off:off + batch_size]
        prompt = "\n".join(f"{off + i}. {l['notes'] or '(empty)'}" for i, l in enumerate(batch))
        body = {
            "model": model,
            "max_tokens": 8000,
            "temperature": 0,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": prompt}],
        }
        if nim:
            body["nvext"] = {"guided_json": schema}
        elif schema_capable:
            body["response_format"] = {"type": "json_schema", "json_schema": {
                "name": "triage_results", "strict": True, "schema": schema}}
        data = None
        for attempt in range(4):
            req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
                "Content-Type": "application/json", "Authorization": f"Bearer {key}"})
            try:
                with urllib.request.urlopen(req, timeout=300) as resp:
                    data = json.load(resp)
                break
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    sys.exit(f"API key rejected ({e.code}). Check the key and try again.")
                if (e.code == 429 or e.code >= 500) and attempt < 3:
                    wait = int(e.headers.get("retry-after") or 0) or (15 if e.code == 429 else 3 * (attempt + 1))
                    time.sleep(wait)
                    continue
                if e.code == 429:
                    sys.exit("Rate limited (429) after 3 retries — free tiers cap requests per "
                             "minute and per day. Wait a few minutes and re-run, or drop the "
                             "':free' suffix to use paid credits.")
                sys.exit(f"API error {e.code}: {e.read().decode(errors='replace')[:300]}")
        text = data["choices"][0]["message"]["content"]
        # reasoning models may wrap output in <think> blocks despite the schema
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
        text = text[text.find("{"):text.rfind("}") + 1]
        if not text:
            sys.exit("The model returned no JSON for a batch; re-run or use the default detector.")
        for r in json.loads(text)["results"]:
            if 0 <= r["index"] < len(leads):
                detections[r["index"]] = {"category": r["category"], "signals": r["signals"]}
        done = min(off + batch_size, len(leads))
        print(f"  AI classification: {done}/{len(leads)}", file=sys.stderr)
    return detections

# ---------------------------------------------------------------- pipeline

def run(path, out_dir=".", ai_model=None):
    with open(path, newline="", encoding="utf-8-sig") as f:
        raw = list(csv.DictReader(f))
    raw = [r for r in raw if any((v or "").strip() for v in r.values())]

    dropped = {"junk_or_test": 0, "duplicate": 0}
    seen_emails, seen_sigs, leads = set(), set(), []

    for r in raw:
        vals = " ".join((v or "") for v in r.values()).lower()
        if r.get("lead_id") in ("header", "lead_id") or "test" in (r.get("source") or "").lower() \
           or (r.get("name") or "").lower() in ("asdf", "test user") or r.get("title") == "title":
            dropped["junk_or_test"] += 1
            continue
        email = clean_email(r.get("email"))
        sig = email or (r.get("name", "").lower().strip() + "|" + r.get("company", "").lower().strip())
        if "(duplicate submission)" in vals or (email and email in seen_emails) or (not email and sig in seen_sigs):
            dropped["duplicate"] += 1
            continue
        if email:
            seen_emails.add(email)
        seen_sigs.add(sig)

        b, bstat = parse_budget(r.get("monthly_budget"))
        lead = {
            "lead_id": (r.get("lead_id") or "").strip(),
            "created": parse_date(r.get("created")),
            "name": (r.get("name") or "").strip(),
            "email_raw": (r.get("email") or "").strip(),
            "email_clean": email,
            "company": (r.get("company") or "").strip(),
            "employees_n": parse_employees(r.get("employees")),
            "website": (r.get("website") or "").strip(),
            "title": (r.get("title") or "").strip(),
            "source": (r.get("source") or "").strip().lower(),
            "budget_usd": b,
            "budget_status": bstat,
            "notes": (r.get("notes") or "").strip(),
        }
        leads.append(lead)

    detections = ai_detect(leads, ai_model) if ai_model else [None] * len(leads)
    via = "ai" if ai_model else "regex"
    for lead, det in zip(leads, detections):
        (lead["score"], lead["intent"], lead["fit"], lead["tier"],
         lead["category"], lead["reasons"]) = score_lead(lead, det, via if det else "regex")

    order = {"CONTACT_NOW": 0, "NURTURE": 1, "DISQUALIFY": 2}
    leads.sort(key=lambda l: (order[l["tier"]], -l["score"]))

    out_csv = f"{out_dir}/triaged_leads.csv"
    with open(out_csv, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["rank", "tier", "score", "lead_id", "name", "email", "company", "title",
                    "employees", "budget_usd_est", "source", "created", "reasons", "notes"])
        for i, l in enumerate(leads, 1):
            w.writerow([i, l["tier"], l["score"], l["lead_id"], l["name"],
                        l["email_clean"] or f"INVALID({l['email_raw']})", l["company"], l["title"],
                        l["employees_n"] or "", f"{l['budget_usd']:.0f}" if l["budget_usd"] else "",
                        l["source"], l["created"] or "", "; ".join(l["reasons"]), l["notes"]])

    counts = collections.Counter(l["tier"] for l in leads)
    dq_cats = collections.Counter(l["category"] for l in leads if l["tier"] == "DISQUALIFY")
    summary = {
        "input_rows": len(raw), "dropped": dropped, "scored_leads": len(leads),
        "detector": via,
        "contact_now": counts["CONTACT_NOW"], "nurture": counts["NURTURE"],
        "disqualify": counts["DISQUALIFY"], "disqualify_breakdown": dict(dq_cats),
        "run_at": datetime.now().isoformat(timespec="seconds"),
    }
    with open(f"{out_dir}/summary.json", "w") as f:
        json.dump(summary, f, indent=2)
    return summary, leads

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_path")
    ap.add_argument("-o", "--out", default=".")
    ap.add_argument("--ai", action="store_true",
                    help="use NVIDIA Nemotron to detect signals (paraphrase-robust; needs an API key)")
    ap.add_argument("--model", default="nvidia/nemotron-3-super-120b-a12b:free",
                    help="model for --ai (default nvidia/nemotron-3-super-120b-a12b:free; "
                         "nvidia/nemotron-3-nano-30b-a3b:free is fastest, "
                         "nvidia/nemotron-3-ultra-550b-a55b:free is best quality)")
    args = ap.parse_args()
    summary, leads = run(args.csv_path, args.out, args.model if args.ai else None)
    print(json.dumps(summary, indent=2))
    print("\nTop 15:")
    for l in leads[:15]:
        print(f"  {l['score']:>3}  {l['tier']:<12} {l['name']:<10} {l['company']:<22} {l['notes'][:60]}")
