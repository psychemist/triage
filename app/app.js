/* Triage — UI layer. Rendering and wiring only; all logic lives in engine.js. */
(function () {
  "use strict";
  const E = window.TriageEngine;
  const $ = id => document.getElementById(id);
  const esc = s => (s ?? "").toString().replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const TIER = {
    CONTACT_NOW: { label: "Contact now", cls: "contact", meter: "g", sw: "g" },
    NURTURE:     { label: "Nurture",     cls: "nurture", meter: "w", sw: "w" },
    DISQUALIFY:  { label: "Disqualified", cls: "dq",     meter: "d", sw: "d" },
  };
  const TIERS = ["CONTACT_NOW", "NURTURE", "DISQUALIFY"];

  let state = null, filterTier = "ALL", query = "", showAll = false, sourceName = "";

  /* ---------------- rendering ---------------- */

  function render() {
    const { leads, dropped, inputRows } = state;
    const counts = {};
    for (const t of TIERS) counts[t] = leads.filter(l => l.tier === t).length;
    const total = leads.length || 1;

    $("runmeta").textContent = `${sourceName} · ${inputRows} rows · ${leads.length} leads scored`;

    $("hero-n").textContent = counts.CONTACT_NOW;
    $("hero-sub").textContent =
      `out of ${leads.length} unique leads — ${inputRows} rows in, ${dropped.junk} junk removed, ${dropped.dupes} duplicates collapsed`;

    $("tier-counts").innerHTML = TIERS.map(t => `
      <div class="tc">
        <div class="n">${counts[t]}</div>
        <div class="lab"><span class="sw ${TIER[t].sw}"></span>${TIER[t].label}</div>
      </div>`).join("");

    $("tierbar").innerHTML = TIERS.map(t => {
      const pct = counts[t] / total * 100;
      const seg = { CONTACT_NOW: "t-contact", NURTURE: "t-nurture", DISQUALIFY: "t-dq" }[t];
      const lab = pct > 12 ? `<span class="seg-label">${TIER[t].label} · ${counts[t]}</span>` : "";
      return `<div class="${seg}" style="width:${pct}%">${lab}</div>`;
    }).join("");

    const dqCats = {};
    for (const l of leads) if (l.tier === "DISQUALIFY") dqCats[l.category] = (dqCats[l.category] || 0) + 1;
    const cats = Object.entries(dqCats).sort((a, b) => b[1] - a[1]);
    const max = cats.length ? cats[0][1] : 1;
    $("dqbars").innerHTML = cats.map(([c, v]) => `
      <div class="hbar-row">
        <span class="name">${esc(c)}</span>
        <span class="hbar-track"><span class="bar" style="width:${v / max * 100}%"></span></span>
        <span class="n">${v}</span>
      </div>`).join("") || `<div class="empty-note">Nothing disqualified.</div>`;

    const badEmails = leads.filter(l => !l.email).length;
    $("waterfall").innerHTML = `
      <div class="wf"><span class="k">Rows read from the export</span><span class="v">${inputRows}</span></div>
      <div class="wf minus"><span class="k">Junk &amp; QA test rows removed</span><span class="v">−${dropped.junk}</span></div>
      <div class="wf minus"><span class="k">Duplicates collapsed <small>(e-mail, then name + company)</small></span><span class="v">−${dropped.dupes}</span></div>
      <div class="wf total"><span class="k">Unique leads scored</span><span class="v">${leads.length}</span></div>
      <div class="wf flag"><span class="k">Invalid e-mails kept &amp; flagged — capped at Nurture</span><span class="v">${badEmails}</span></div>`;

    $("tabs").innerHTML =
      `<button data-tier="ALL" class="${filterTier === "ALL" ? "on" : ""}">All<span class="ct">${leads.length}</span></button>` +
      TIERS.map(t =>
        `<button data-tier="${t}" class="${filterTier === t ? "on" : ""}">${TIER[t].label}<span class="ct">${counts[t]}</span></button>`).join("");

    renderTable();
    $("btn-export").hidden = false;
    $("dropzone").hidden = true;
    $("results").hidden = false;
  }

  function renderTable() {
    const rows = state.leads.filter(l =>
      (filterTier === "ALL" || l.tier === filterTier) &&
      (!query || (l.name + " " + l.company + " " + l.notes + " " + l.title).toLowerCase().includes(query)));
    const limit = showAll ? rows.length : 60;

    $("tbody").innerHTML = rows.length ? rows.slice(0, limit).map(l => `
      <tr class="lead" data-rank="${l.rank}" tabindex="0" aria-expanded="false">
        <td class="num rank">${l.rank}</td>
        <td><span class="chip ${TIER[l.tier].cls}">${TIER[l.tier].label}</span></td>
        <td class="num"><span class="scorecell"><span class="meter ${TIER[l.tier].meter}"><i style="width:${l.score}%"></i></span><span class="v">${l.score}</span></span></td>
        <td class="leadname"><b>${esc(l.name) || "—"}</b>${l.email ? "" : `<div class="badmail">invalid e-mail</div>`}</td>
        <td>${esc(l.company)}</td>
        <td>${esc(l.title)}</td>
        <td class="num">${l.budget ? "$" + Math.round(l.budget).toLocaleString() : l.budgetStatus === "tbd" ? "TBD" : ""}</td>
        <td>${esc(l.source)}</td>
        <td class="notecell" title="${esc(l.notes)}">${esc(l.notes)}</td>
      </tr>`).join("")
      : `<tr><td colspan="9"><div class="empty-note">No leads match this filter.</div></td></tr>`;

    $("btn-more").hidden = showAll || rows.length <= limit;
    $("btn-more").textContent = `Show all ${rows.length} rows`;
  }

  function chipHTML(r) {
    if (r.pts === null) return `<span>${esc(r.label)}</span>`;
    const cls = r.pts < 0 ? "neg" : "";
    return `<span><b class="${cls}">${r.pts >= 0 ? "+" : ""}${r.pts}</b> ${esc(r.label)}</span>`;
  }

  function toggleDetail(tr) {
    const isOpen = tr.nextElementSibling?.classList.contains("detail");
    document.querySelectorAll("tr.detail").forEach(d => d.remove());
    document.querySelectorAll("tr.lead.open").forEach(x => { x.classList.remove("open"); x.setAttribute("aria-expanded", "false"); });
    if (isOpen) return;

    const l = state.leads.find(x => x.rank === +tr.dataset.rank);
    const intentChips = l.reasons.filter(r => r.group === "intent");
    const fitChips = l.reasons.filter(r => r.group === "fit");
    const gates = l.reasons.filter(r => r.group === "gate");

    const d = document.createElement("tr");
    d.className = "detail";
    d.innerHTML = `<td colspan="9">
      ${gates.map(g => `<div class="gateline">${esc(g.label)}</div>`).join("")}
      ${(intentChips.length || fitChips.length) ? `
      <div class="breakdown">
        <div class="siggroup">
          <div class="microlabel"><span>Intent — what the notes say</span><span class="pts">${l.intent} / 60</span></div>
          <div class="sigmeter"><i style="width:${l.intent / 60 * 100}%"></i></div>
          <div class="sigchips">${intentChips.map(chipHTML).join("") || "<span>no intent signals</span>"}</div>
        </div>
        <div class="siggroup">
          <div class="microlabel"><span>Fit — who the lead is</span><span class="pts">${l.fit} / 40</span></div>
          <div class="sigmeter"><i style="width:${l.fit / 40 * 100}%"></i></div>
          <div class="sigchips">${fitChips.map(chipHTML).join("") || "<span>no fit signals</span>"}</div>
        </div>
      </div>` : ""}
      <div class="fullnote"><b>Notes:</b> ${esc(l.notes) || "—"}</div>
      <div class="detail-meta">E-mail: ${l.email ? esc(l.email)
        : `<span class="badmail" style="display:inline">invalid — raw value: ${esc(l.emailRaw) || "empty"}</span>`}
        ${l.leadId ? ` · Lead ID: ${esc(l.leadId)}` : ""}</div>
    </td>`;
    tr.after(d);
    tr.classList.add("open");
    tr.setAttribute("aria-expanded", "true");
  }

  /* ---------------- wiring ---------------- */

  function load(rawRows, name) {
    sourceName = name;
    state = E.runPipeline(rawRows);
    filterTier = "ALL"; query = ""; showAll = false;
    $("search").value = "";
    render();
    window.scrollTo({ top: 0 });
  }

  function loadFile(f) { f.text().then(t => load(E.parseCSV(t), f.name)); }

  $("btn-demo").onclick = () => load(window.DEMO_DATA, "cohort_3_leads.csv");
  $("btn-upload").onclick = () => $("file").click();
  $("file").onchange = e => { if (e.target.files[0]) loadFile(e.target.files[0]); };

  const dz = $("dropzone");
  for (const el of [dz, document.body]) {
    el.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
    el.addEventListener("dragleave", () => dz.classList.remove("drag"));
    el.addEventListener("drop", e => {
      e.preventDefault(); dz.classList.remove("drag");
      if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });
  }

  $("tabs").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    filterTier = b.dataset.tier; showAll = false;
    for (const x of $("tabs").children) x.classList.toggle("on", x === b);
    renderTable();
  });
  $("search").addEventListener("input", e => { query = e.target.value.toLowerCase(); renderTable(); });
  $("btn-more").onclick = () => { showAll = true; renderTable(); };
  $("tbody").addEventListener("click", e => { const tr = e.target.closest("tr.lead"); if (tr) toggleDetail(tr); });
  $("tbody").addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      const tr = e.target.closest("tr.lead");
      if (tr) { e.preventDefault(); toggleDetail(tr); }
    }
  });

  $("btn-export").onclick = () => { $("csvout").value = E.toCSV(state.leads); $("modal").classList.add("open"); };
  $("btn-close").onclick = () => $("modal").classList.remove("open");
  $("modal").addEventListener("click", e => { if (e.target === $("modal")) $("modal").classList.remove("open"); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") $("modal").classList.remove("open"); });
  $("btn-copy").onclick = async () => {
    const ta = $("csvout"); ta.select();
    try { await navigator.clipboard.writeText(ta.value); }
    catch { document.execCommand("copy"); }
    $("btn-copy").textContent = "Copied ✓";
    setTimeout(() => $("btn-copy").textContent = "Copy to clipboard", 1500);
  };
})();
