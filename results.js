const { rankResults, resultsCsv, money, formatProfit, isProfitable, steamListingUrl, RESULT_PREFIX } = globalThis.BMX;
const $ = (id) => document.getElementById(id);
let all = [];
let shown = [];
const selected = new Set();

const el = (tag, attrs = {}, text) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text; // names are never parsed as HTML
  return e;
};
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${(s / 3600).toFixed(1)}h ago` : `${(s / 86400).toFixed(1)}d ago`;
};
const when = (t) => new Date(t).toLocaleString();
const num = (id, scale = 1) => ($(id).value === "" ? null : Math.round(Number($(id).value) * scale));

function opts() {
  return {
    query: $("query").value.trim(), sort: $("sort").value, minRoiBp: num("minRoi", 100), minSales: num("minSales"),
    minCost: num("minCost", 100), maxCost: num("maxCost", 100), maxAgeMin: num("maxAge"),
    hideThin: $("hideThin").checked, hidePremium: $("hidePremium").checked,
  };
}

function cell(text, cls = "num", title) {
  const td = el("td", { class: cls }, text);
  if (title) td.title = title;
  return td;
}

function render() {
  shown = rankResults(all, opts());
  for (const n of [...selected]) if (!all.some((r) => r.name === n)) selected.delete(n);
  const tb = $("rows");
  tb.replaceChildren();
  for (const r of shown) {
    const W = r.walletCurrency;
    const tr = el("tr");
    const cb = el("input", { type: "checkbox" });
    cb.checked = selected.has(r.name);
    cb.addEventListener("change", () => { cb.checked ? selected.add(r.name) : selected.delete(r.name); updateButtons(); });
    const cbTd = el("td");
    cbTd.append(cb);
    tr.append(cbTd);

    const nameTd = el("td", { class: "name" });
    nameTd.append(el("span", {}, r.name), el("br"));
    if (r.thin) nameTd.append(el("span", { class: "tag", title: "Fewer than 5 Steam sales in 24h (or unknown)" }, "thin"));
    if (r.premium) nameTd.append(el("span", { class: "tag", title: "Pattern/phase/float premium not priced" }, "pattern"));
    if (r.page && r.page.level !== "supported") nameTd.append(el("span", { class: "tag", title: `Captured on ${r.page.label}: card price may be a specific listing, not the cheapest` }, r.page.label));
    if (r.lookups > 1) nameTd.append(el("span", { class: "muted", title: `First seen ${when(r.firstSeenAt)}` }, `${r.lookups} lookups`));
    tr.append(nameTd);

    const link = (href, text) => el("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
    const linksTd = el("td", { class: "links" });
    linksTd.append(link(r.href, "BUFF"), " – ", link(steamListingUrl(r.name), "Steam"));
    tr.append(linksTd);

    tr.append(cell(money(r.cost, W), "num", `BUFF lowest listing ${money(r.buff.cents, r.buff.currency)} + fees ` +
      `(${r.assumptions.buffFeePct}% + ${money(r.assumptions.buffFixedFeeCents, W)}, FX markup ${r.assumptions.fxMarkupPct}%)` +
      (r.fxDate ? ` · ECB ${r.fxDate}` : "")));
    tr.append(cell(money(r.steam.lowestAsk, W)));
    tr.append(cell(`${r.steam.volume24h ?? "?"} / ${money(r.steam.median24h, W)}`));
    tr.append(cell(r.sellAt === null ? "—" : `${money(r.sellAt, W)} → ${money(r.credit, W)}`, "num", `Sell basis: ${r.sellBasis} · fees ${r.feeRule} (estimated)`));
    tr.append(cell(formatProfit(r.roiBp, r.gain, W), `num ${r.gain > 0 ? "pos" : r.gain < 0 ? "neg" : ""}`,
      "Wallet-value ROI (gain). Sorting uses the percentage."));
    tr.append(cell(ago(r.steamFetchedAt), "", when(r.steamFetchedAt)));
    const del = el("button", { class: "x", title: "Delete this result" }, "✕");
    del.addEventListener("click", () => remove([r.name]));
    const delTd = el("td");
    delTd.append(del);
    tr.append(delTd);
    tb.append(tr);
  }
  $("empty").hidden = shown.length > 0;
  const currencies = new Set(all.map((r) => r.walletCurrency));
  $("summary").textContent = `${all.length} saved · ${shown.length} shown` +
    (currencies.size > 1 ? ` · ⚠ mixed wallet currencies (${[...currencies].join(", ")}): compare like with like` : "");
  for (const th of document.querySelectorAll("th[data-sort]")) th.style.textDecoration = th.dataset.sort === $("sort").value ? "underline" : "";
  updateButtons();
}

function updateButtons() {
  $("delSel").textContent = `Delete selected (${selected.size})`;
  $("delSel").disabled = selected.size === 0;
  $("delShown").disabled = shown.length === 0;
  $("delAll").disabled = all.length === 0;
  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(r.name));
  $("selAll").checked = allShownSelected;
}

async function remove(names) {
  await chrome.storage.local.remove(names.map((n) => RESULT_PREFIX + n));
  names.forEach((n) => selected.delete(n));
  // storage.onChanged reloads the list
}

async function load() {
  const items = await chrome.storage.local.get(null);
  const entries = Object.entries(items).filter(([k]) => k.startsWith(RESULT_PREFIX));
  // Rows saved before "positive only" was introduced are cleaned up here.
  const stale = entries.filter(([, v]) => !isProfitable(v)).map(([k]) => k);
  if (stale.length) await chrome.storage.local.remove(stale);
  all = entries.filter(([, v]) => isProfitable(v)).map(([, v]) => v);
  render();
}

$("selAll").addEventListener("change", (e) => {
  for (const r of shown) e.target.checked ? selected.add(r.name) : selected.delete(r.name);
  render();
});
$("delSel").addEventListener("click", () => {
  if (confirm(`Delete ${selected.size} selected result(s)?`)) remove([...selected]);
});
$("delShown").addEventListener("click", () => {
  if (confirm(`Delete the ${shown.length} result(s) currently shown?`)) remove(shown.map((r) => r.name));
});
$("delAll").addEventListener("click", () => {
  if (confirm(`Delete ALL ${all.length} saved results?`)) remove(all.map((r) => r.name));
});
$("csv").addEventListener("click", () => {
  const blob = new Blob([resultsCsv(shown)], { type: "text/csv" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `buff-steam-results-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
for (const id of ["query", "sort", "minRoi", "minSales", "minCost", "maxCost", "maxAge", "hideThin", "hidePremium"]) {
  $(id).addEventListener("input", render);
}
for (const th of document.querySelectorAll("th[data-sort]")) {
  th.addEventListener("click", () => { $("sort").value = th.dataset.sort; render(); });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some((k) => k.startsWith(RESULT_PREFIX))) load();
});
setInterval(render, 30000); // keep "x ago" columns current
load();
