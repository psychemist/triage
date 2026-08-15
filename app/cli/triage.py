#!/usr/bin/env python3
"""
Lead Triage — automated lead qualification pipeline (CLI).

Usage:
    python3 triage.py <leads.csv> [-o out_dir]

Reads a raw lead export (messy is fine), cleans + dedupes it, scores every
lead on Intent (what the notes say) and Fit (who the lead is), and writes:
    - triaged_leads.csv   ranked list with score, tier, and reasons
    - summary.json        counts + run metadata

Signals are detected with regex patterns mined from known phrasings.

Tiers: CONTACT_NOW / NURTURE / DISQUALIFY
"""
import csv, json, re, sys, argparse, collections
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
# Single source of truth, mirrored by the web app's engine.js.

GATES = {
    "spam": [
        r"won \$|you have won|claim your (prize|reward)|congratulations,? you",
        r"click here|limited time offer|act now|make money fast|work from home",
        r"smm panel|buy (followers|likes|traffic)|cheap traffic|social media boost",
        r"backlinks|high.?da links|guaranteed (rank|first page)|rank #?\d+ guaranteed",
        r"bulk email blasting|mass mailer|email blast service|scraped (list|leads) for sale",
        r"offshore (dev|team|developers)|dedicated developers at|staff augmentation|\$\d+/hr",
        r"dm for rates|crypto|bitcoin|forex|lottery|inheritance|wire transfer",
    ],
    "job seeker": [
        r"looking for a (role|job|position)|seeking (a )?(role|position|employment)|open to work",
        r"attaching my (cv|resume)|my (cv|resume) is attached|resume attached|here'?s my cv",
        r"are you hiring|any (openings|vacancies)|join your team|apply for a (job|role)",
        r"hire me|available for hire|looking for work|internship",
    ],
    "recruiter": [
        r"place candidates|candidates for you|our bench|devs on (our|the) bench",
        r"staffing agency|recruiting firm|headhunt|talent pool|we supply (developers|talent)",
    ],
    "student / learner": [
        r"\bstudent\b|bootcamp grad|final year|freshman|undergrad|postgrad",
        r"university project|school project|class project|thesis|dissertation|coursework|academic research",
        r"free (template|material|materials|resources|course|guide)|any free",
        r"just learning|learning purposes|teach me|mentor me|how did you (build|make)|share how you built",
    ],
    "press / VC": [
        r"journalist|reporter|writing (an article|a piece|a story)|press inquiry|media inquiry",
        r"looking for a quote|for our publication|blog post about|feature you|on our podcast",
        r"\bvc here\b|venture capital|angel investor|portfolio compan|due diligence",
        r"not a (direct )?buyer|not a client|not looking to buy",
    ],
    "competitor": [
        r"competing (automation )?agency|competitor|rival agency|we run a similar|also an automation agency",
        r"benchmark|fellow agency owner|researching the market|market research|scoping the competition",
        r"we do similar work|we offer the same|curious how you price for comparison",
    ],
    "test row": [
        r"test entry|test test|qa test|please ignore|ignore this|dummy (data|entry|row)",
        r"sample row|placeholder|lorem ipsum|^\s*(test|asdf|xxx)\s*$",
        r"newsletter signup|mailing list signup|subscribed by mistake",
    ],
    # Affordability gate. Deliberately excludes "no budget *yet*" phrasings —
    # those are a timing problem, not a fit problem, and NURTURE_FLOOR owns them.
    "low budget": [
        r"can'?t really pay|can ?not afford|can'?t afford|too expensive for us",
        r"tiny budget|shoestring|no budget at all|zero budget|budget way below range",
        r"out of our (price )?range|below our range|way out of budget",
        r"looking for (something )?free|free (option|version|tier|plan)|pro bono|only if it'?s free",
    ],
}

SIGNALS = {  # name: (points, label, regex)
    "budget_approved": (20, "budget approved",
        r"budget (is )?approved|approved budget|budget (secured|confirmed|in place|allocated)|allocated budget|we have the budget|funding (is )?approved|signed off on (the )?budget|sign.?off on (spend|budget)|have sign.?off"),
    "urgent_timeline": (18, "urgent timeline",
        r"asap|urgent|right away|immediately|move fast|moving fast|start (this|next) month|start now|decision this month|pilot in the next|in \d+ weeks|priority for the quarter|this quarter|time.sensitive|need this (done )?(by|before)|kick.?off (this|next) month"),
    "acute_pain": (15, "acute pain named",
        r"eating (up )?(our|the) (week|time|days|hours)|wasting (hours|time|days)|burning (hours|time)|takes (us )?(hours|days)|too much time|time.consuming|tedious|manual(ly)?.{0,25}(every|each) (day|week)|drowning in|swamped|bottleneck|can'?t keep up|falling behind|nightmare|painful"),
    "wants_full_automation": (12, "wants full automation",
        r"end.to.end|fully automated?|full automation|completely automated?|hands.off|automate the whole|entire (process|workflow)|from start to finish|without (any )?manual|no manual"),
    "decision_maker": (10, "decision-maker",
        r"decision is mine|i make the call|my priority to solve|my decision|i decide|i sign off|i can approve|final say|i own (this|the budget)|i'?m the (owner|founder|ceo|decision.maker)"),
    "active_evaluation": (8, "active evaluation",
        r"comparing (a few |several |multiple )?(options|vendors|tools|providers|solutions)|evaluating (a few|several|options|vendors|tools)|shortlist|looking at alternatives|getting quotes|\brfp\b|request for proposal|in talks with|demos? with"),
    "decision_month": (6, "decision ~1 month",
        r"decision (in|within) (about )?a (month|few weeks)|deciding (this|next) month|decide (in|within).{0,12}(month|weeks)|timeline is.{0,15}month"),
    "has_some_budget": (5, "has some budget",
        r"have some budget|some budget|budgeted|budget exists|funds available|money set aside|allocated some"),
    "named_workflow": (4, "named a workflow",
        r"automat|streamline|workflow|manual process|copy.?past|data entry|integrat|sync (between|with)"),
    "no_clear_authority": (-1, "no clear authority",
        r"who signs off|loop in the team|need to (check|ask|run it by|consult)|not sure who (decides|signs)|team decision|committee|get approval|internal buy.?in|my (boss|manager|partner) (would|will|needs)"),
    # Evasive or undecided about spend — NOT "no budget yet", which is a timing
    # signal handled by NURTURE_FLOOR rather than a penalty.
    "budget_not_committed": (-2, "budget not committed",
        r"budget not locked|won'?t share budget|wont share budget|depends what you can do|budget (is )?tbd|haven'?t (set|decided).{0,12}budget|budget (undecided|not set|not decided)|need to figure out budget"),
    "price_sensitive": (-4, "price sensitive",
        r"price.sensitive|cost.conscious|cheapest|lowest price|budget.friendly|what do you charge|how much (does it|do you) cost|discount|negotiate on price"),
    "vague_scope": (-6, "vague on scope",
        r"not totally sure what we need|not sure what (we need|exactly)|vague on scope|don'?t know what we (need|want)|still figuring (it )?out|just exploring|not sure where to start|open to ideas|early research"),
    "deferred_interest": (-10, "deferred interest",
        r"maybe later|later this year|next year|not right now|not at the moment|circle back|revisit (in|next|later)|touch base (in|later)|down the (road|line)|in a few months|keep me posted"),
}

# Leads that say "not now, but plausibly later" — pre-revenue, early-stage, or
# deferring on budget while showing promise. A timing problem, not a fit problem,
# so they are never disqualified: the floor guarantees at least NURTURE without
# inflating the score, keeping the ranking inside NURTURE honest.
NURTURE_FLOOR = [
    r"early.stage|early startup|very early|early days|just (got )?started|starting out|new (agency|business)",
    r"pre.?revenue|pre.?seed|bootstrapp?ed|no real budget yet|budget (next|by next) (quarter|year)",
    r"might grow|but sharp|small but growing|growing fast|scaling up|plan to scale",
    r"too early (for us|right now)|not ready (yet|to buy)|revisit when we (grow|scale)",
]

# The floor rescues a lead from the affordability gate only — "no budget yet" is
# forgivable, being a recruiter or a competitor is not.
RESCUABLE_GATES = {"low budget"}

def has_nurture_floor(notes):
    return any(re.search(p, notes) for p in NURTURE_FLOOR)

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
            if category in RESCUABLE_GATES and has_nurture_floor(notes):
                continue
            return {"category": category, "signals": []}
    return {"category": "prospect",
            "signals": [k for k, (_, _, pat) in SIGNALS.items() if re.search(pat, notes)]}

def score_from_detection(lead, detection):
    """Shared scoring back half. Returns (score, intent, fit, tier, category, reasons)."""
    notes = (lead["notes"] or "").lower()

    # Applied here as well as in detect_signals so the rescue holds however the
    # category was produced.
    rescued = (detection["category"] != "prospect"
               and detection["category"] in RESCUABLE_GATES and has_nurture_floor(notes))
    if detection["category"] != "prospect" and not rescued:
        return 0, 0, 0, "DISQUALIFY", detection["category"], [f"hard disqualifier: {detection['category']}"]
    if not notes.strip():
        return 0, 0, 0, "DISQUALIFY", "no information", ["empty notes — nothing to qualify on"]

    reasons = []
    intent = 0
    for name in detection["signals"]:
        if name not in SIGNALS:
            continue
        pts, label, _ = SIGNALS[name]
        intent += pts
        reasons.append(f"{'+' if pts >= 0 else ''}{pts} {label}")
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

    # A floored lead can be lifted to NURTURE but never demoted — the floor is a
    # minimum, not an assignment, so a funded lead saying "we're growing fast"
    # still reaches CONTACT_NOW on its own score.
    floored = has_nurture_floor(notes)
    if floored and score < 14:
        reasons.append("early-stage — kept for nurture rather than disqualified")

    if score >= 60 and lead["email_clean"]:
        tier = "CONTACT_NOW"
    elif score >= 14 or floored:
        tier = "NURTURE"
    else:
        tier = "DISQUALIFY"
    if tier == "DISQUALIFY":
        return score, intent, fit, tier, "low intent / poor fit", reasons
    return score, intent, fit, tier, "prospect", reasons

def score_lead(lead, detection=None):
    if detection is None:
        detection = detect_signals((lead["notes"] or "").lower())
    return score_from_detection(lead, detection)

# ---------------------------------------------------------------- pipeline

def run(path, out_dir="."):
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

    for lead in leads:
        (lead["score"], lead["intent"], lead["fit"], lead["tier"],
         lead["category"], lead["reasons"]) = score_lead(lead)

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
    args = ap.parse_args()
    summary, leads = run(args.csv_path, args.out)
    print(json.dumps(summary, indent=2))
    print("\nTop 15:")
    for l in leads[:15]:
        print(f"  {l['score']:>3}  {l['tier']:<12} {l['name']:<10} {l['company']:<22} {l['notes'][:60]}")
