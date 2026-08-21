# Triage — Automated Lead Qualification

Takes a raw lead export (messy is fine), cleans it, reads every lead's notes,
scores **intent** (0–60) and **fit** (0–40), and ranks the whole pipeline into
**Contact now / Nurture / Disqualify** — with the reasoning attached to every lead.

Everything runs client-side. No server, no dependencies, no data leaves the machine.

## Run it

```
open index.html          # macOS — or just double-click it
```

## Self-host it

The whole app is 5 static files (`index.html`, `styles.css`, `engine.js`,
`app.js`, `demo-data.js`) — no backend, no build step, no external requests.
Any static file server hosts it as-is.

**Local network / quick share** (from this directory):

```
python3 -m http.server 8080        # → http://<your-ip>:8080
# or
npx serve .
```

**Docker** (nginx with gzip, port 8080):

```
docker compose up -d               # → http://localhost:8080
# or without compose:
docker build -t triage . && docker run -d -p 8080:80 triage
```

**Static hosts** — push this directory to a repo and point any of these at it
(zero config, free tiers):

- **GitHub Pages** — Settings → Pages → deploy from branch, root = this folder
- **Netlify / Cloudflare Pages / Vercel** — drag-and-drop the folder or connect
  the repo; no build command, publish directory = this folder

**Single-file fallback** — `dist/app.html` is the entire app inlined into one
file (regenerate with `python3 build.py`). Drop it on any host, S3 bucket, or
even attach it to an e-mail; it works opened directly from disk too.

Privacy note: hosting only serves the code — uploaded CSVs are still parsed
entirely in the visitor's browser and never touch the server.

Click **Run the Cohort 3 demo export**, or drop any lead CSV onto the page.
Columns are auto-detected by name (`name`, `email`, `company`, `title`,
`employees`, `source`, `monthly_budget`, `notes` — order doesn't matter).

For scheduled/batch runs, the identical engine ships as a CLI:

```
python3 cli/triage.py data/cohort_3_leads.csv
```

writes `triaged_leads.csv` (ranked, with reasons) and `summary.json`.

## Layout

```
index.html        markup
styles.css        visual system (light + dark, three-state theme tokens)
engine.js         cleaning + classification + scoring (browser & Node)
app.js            UI layer — rendering and wiring only
demo-data.js      Cohort 3 export bundled as JS (so file:// works, no fetch/CORS)
data/             the raw demo CSV
cli/triage.py     Python port of the engine for batch runs
build.py          inlines everything into dist/app.html (single shareable file)
test_parity.mjs   asserts the JS engine reproduces the canonical numbers
dist/app.html     built single-file version (what the hosted artifact serves)
```

## AI mode (optional)

The built-in detector matches known phrasings with regex patterns. **AI mode**
has an open model — NVIDIA's Nemotron 3 (open weights) — read every note and
report the *same named signals* — so paraphrases the patterns miss ("we have
sign-off on spend and want to move quickly" → *budget approved* + *urgent
timeline*) still count. Scoring weights, tiers, and per-lead explanations are
identical in both modes; only the detection layer swaps. AI-detected signals
are tagged `(AI)` in the reason chips.

**It runs on a free-tier key** — every model in the picker is a no-cost
variant, so AI mode costs nothing to try.

**Web app:** after a run, open the "AI signal detection" panel, paste a key
(kept in memory for the session — never stored), pick a model, and hit
*Re-score with AI*. The key picks the route:

- **OpenRouter key** (`sk-or-…`, free at openrouter.ai/keys) — calls go
  straight from the browser to openrouter.ai (CORS-open), so it works
  self-hosted, on static hosts, or from a local file. The hosted claude.ai
  demo blocks external requests and will say so.
- **NVIDIA key** (`nvapi-…`, free at build.nvidia.com) — NVIDIA's API blocks
  browser CORS, so this route only works on the Docker self-host, whose nginx
  proxies `/nim/` to integrate.api.nvidia.com (the key passes through, nothing
  is logged).

**CLI** (no SDK needed — plain stdlib HTTP):

```
export NVIDIA_API_KEY=nvapi-...            # or OPENROUTER_API_KEY=sk-or-...
python3 cli/triage.py data/cohort_3_leads.csv --ai
python3 cli/triage.py data/cohort_3_leads.csv --ai --model nvidia/nemotron-3-nano-30b-a3b:free
```

Models — all free, pick on speed vs. size:

| slug | notes |
| --- | --- |
| `nvidia/nemotron-3-super-120b-a12b:free` | default — recommended; the only free variant that enforces the JSON schema on OpenRouter |
| `nvidia/nemotron-3-nano-30b-a3b:free` | fastest; JSON comes from the prompt, not enforced |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | largest and slowest; JSON comes from the prompt, not enforced |

Super is the default because OpenRouter only advertises `structured_outputs`
for that variant — and it silently *drops* parameters a model doesn't support,
so the schema would vanish on the other two. The code therefore sends the
schema only where it's honored; elsewhere the system prompt demands a bare
JSON object and the parser strips `<think>` blocks and code fences before
reading it. On NVIDIA's own route every model gets guided decoding, so all
three are schema-enforced there.

The `:free` suffix is OpenRouter's no-cost pool; NVIDIA's own API only knows
the bare slug, so the code strips the suffix on that route — the same picker
entry works with either key. Free tiers cap requests per minute and per day
(one 503-lead run is ~21 requests at 25 leads per batch), so a run or two a
day is comfortable; on a 429 the client backs off, retries three times, then
says plainly that you're rate-limited. Drop the `:free` suffix to spend
credits for higher limits (~3¢ per 500 leads on Super).

Classification uses schema-constrained output (guided JSON over the signal
catalog) plus a tolerant parser, so responses stay parseable.

## Qualification logic (short version)

1. **Hard disqualifiers** — spam, students, job seekers, recruiters, press/VC,
   competitors, test rows, budgets explicitly below range.
2. **Intent 0–60**, mined from notes — "budget approved" +25, urgent timeline +18,
   named pain ("…eating our week") +15, end-to-end ask +12, decision-maker +10;
   dampeners: no budget −15, "maybe later" −10, price-sensitive / unclear
   authority / vague scope −8.
3. **Fit 0–40** — budget size, team size (10–120 sweet spot), title seniority,
   source quality (referral > event > LinkedIn > webform > cold reply), agency = ICP.
4. **Tiers** — Contact now: score ≥ 55 **and** a valid e-mail. Nurture: 15–54,
   or a good lead with a broken e-mail (kept and flagged, never dropped).
   Disqualify: hard category or score < 15.

Canonical result on the Cohort 3 export: 520 rows → 503 unique leads →
**103 contact now · 212 nurture · 188 disqualified**.

## Verify / rebuild

```
node test_parity.mjs     # engine parity against the canonical numbers
python3 build.py         # regenerate dist/app.html after edits
```
