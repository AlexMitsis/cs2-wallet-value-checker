const D = globalThis.BMX.DEFAULT_SETTINGS;
const $ = (id) => document.getElementById(id);
const NUM = ["buffFeePct", "fxMarkupPct", "undercutTicks", "hoverDelayMs", "cacheMinutes", "maxPerMinute"];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

chrome.storage.sync.get(D).then((s) => {
  $("walletCurrency").value = s.walletCurrency;
  for (const k of NUM) $(k).value = s[k];
  $("buffFixedFee").value = (s.buffFixedFeeCents / 100).toFixed(2);
  $("saveResults").checked = s.saveResults;
});

$("save").addEventListener("click", async () => {
  const s = {
    walletCurrency: $("walletCurrency").value,
    buffFeePct: clamp(Number($("buffFeePct").value) || 0, 0, 50),
    fxMarkupPct: clamp(Number($("fxMarkupPct").value) || 0, 0, 20),
    undercutTicks: clamp(Math.round(Number($("undercutTicks").value) || 0), 0, 1000),
    hoverDelayMs: clamp(Math.round(Number($("hoverDelayMs").value) || 500), 200, 3000),
    cacheMinutes: clamp(Math.round(Number($("cacheMinutes").value) || 5), 1, 120),
    maxPerMinute: clamp(Math.round(Number($("maxPerMinute").value) || 12), 1, 20),
    buffFixedFeeCents: Math.round(clamp(Number($("buffFixedFee").value) || 0, 0, 1000) * 100),
    saveResults: $("saveResults").checked,
  };
  await chrome.storage.sync.set(s);
  $("saved").textContent = "Saved" + (s.walletCurrency !== "USD" ? " (cached Steam prices are per currency)" : "");
  setTimeout(() => ($("saved").textContent = ""), 3000);
});
