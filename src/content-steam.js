/* "Verify on Steam" overlay. Only active on tabs the extension opened from a BUFF popup.
   Steam's Market Beta page groups all exteriors/qualities and mixes them in its listing feed, so the
   overlay never auto-reads a price: you select the exact variant and type the price you see. */
(async () => {
  const { evaluate, money, pct, parseTypedPrice, describeVariant } = globalThis.BMX;
  let ctx;
  try { ctx = await chrome.runtime.sendMessage({ type: "verifyContext" }); } catch { return; }
  if (!ctx || !ctx.ok) return; // a tab you opened yourself: do nothing

  const W = ctx.settings.walletCurrency;
  const v = describeVariant(ctx.name);
  const host = document.createElement("div");
  host.id = "bmx-verify";
  host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;";
  const sh = host.attachShadow({ mode: "open" });
  sh.innerHTML = `<style>
    .p{width:330px;background:#11161d;color:#e6edf3;border:2px solid #d29922;border-radius:8px;padding:10px 12px;font:12px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.6)}
    h3{margin:0 0 4px;font-size:13px} .n{font-weight:600;word-break:break-word} .k{color:#8b949e}
    .sel{background:#2d2205;border-radius:5px;padding:6px 8px;margin:6px 0;color:#f0c674}
    input{width:100%;box-sizing:border-box;margin-top:3px;padding:5px;border-radius:4px;border:1px solid #3b4757;background:#0d1117;color:#e6edf3;font:13px ui-monospace,monospace}
    table{width:100%;border-collapse:collapse;margin-top:6px} td.v{text-align:right;font-family:ui-monospace,monospace}
    .pos{color:#3fb950;font-weight:700} .neg{color:#f85149;font-weight:700} .m{color:#8b949e;font-size:11px;margin-top:6px}
    .ok{color:#3fb950} .bad{color:#f85149} button{background:none;border:0;color:#8b949e;cursor:pointer;float:right;font-size:14px}
  </style><div class="p" id="p"></div>`;
  const p = sh.getElementById("p");
  const el = (t, a = {}, x) => { const e = document.createElement(t); for (const [k, val] of Object.entries(a)) e.setAttribute(k, val); if (x !== undefined) e.textContent = x; return e; };

  const close = el("button", { title: "Close" }, "✕");
  close.addEventListener("click", () => host.remove());
  p.append(close, el("h3", {}, "Verify against BUFF.Market"), el("div", { class: "n" }, ctx.name));
  const titleCheck = el("div", { class: "k" });
  p.append(titleCheck);
  const sel = el("div", { class: "sel" });
  const picks = [v.exterior && `Exterior “${v.exterior}”`, (v.exterior || v.quality !== "Normal") && `Category “${v.quality}”`].filter(Boolean);
  sel.append(el("div", {}, picks.length ? `On this page select: ${picks.join(", ")}.` : "Check the page shows exactly this item."),
    el("div", {}, "Use the lowest listing of that exact variant. Ignore the mixed “Found N results” feed until filtered."));
  p.append(sel);
  p.append(el("div", { class: "k" }, `BUFF lowest listing: ${money(ctx.buff.cents, ctx.buff.currency)}`));
  if (ctx.api) {
    const ago = Math.round((Date.now() - ctx.api.fetchedAt) / 60000);
    p.append(el("div", { class: "k" }, `Steam API lowest ask (any listing of this name): ${money(ctx.api.lowestAsk, ctx.api.currency)} · ${ago} min ago`));
  }
  const label = el("label", { class: "k" }, `Lowest Steam price you see for this variant (${W}):`);
  const input = el("input", { inputmode: "decimal", placeholder: W === "EUR" ? "e.g. 28,63" : "e.g. 28.63" });
  label.append(input);
  p.append(label);
  const out = el("div");
  p.append(out);
  p.append(el("div", { class: "m" }, "If the page shows a different currency than your wallet setting, the comparison is wrong — sign in or change the setting."));

  function check() {
    const body = document.body.innerText || "";
    if (/made too many requests recently/i.test(body)) {
      titleCheck.className = "bad";
      titleCheck.textContent = "Steam is rate-limiting this connection (too many requests). Wait a few minutes and reload; the hover figures still apply.";
      return;
    }
    if (/An error was encountered while processing your request/i.test(body)) {
      titleCheck.className = "bad";
      titleCheck.textContent = "Steam returned an error page. Reload in a moment.";
      return;
    }
    const h = [...document.querySelectorAll("h1")].map((x) => x.textContent.trim());
    const found = h.some((t) => t === v.base || t === ctx.name || t.endsWith(v.base));
    titleCheck.className = found ? "ok" : "bad";
    titleCheck.textContent = found ? `✓ Page is for “${v.base}” (exterior/category: check above)` : `✗ Page title doesn't match “${v.base}” — wrong item?`;
  }
  function recompute() {
    out.replaceChildren();
    const cents = parseTypedPrice(input.value);
    if (!cents) return;
    const r = evaluate(ctx.name, ctx.buff, { status: "ok", currency: W, lowestAsk: cents, median24h: null, volume24h: null },
      ctx.settings, ctx.fx?.rates || {});
    if (!r.conservative) { out.append(el("div", { class: "bad" }, r.warnings[0] || "Cannot compute.")); return; }
    if (ctx.api && ctx.api.currency === W && (cents > ctx.api.lowestAsk * 2 || cents * 2 < ctx.api.lowestAsk)) {
      out.append(el("div", { class: "bad" }, `This differs a lot from the API's ${money(ctx.api.lowestAsk, W)} — is the right exterior/category selected?`));
    }
    const t = el("table");
    const tr = (a, b, c = "") => { const x = el("tr", c ? { class: c } : {}); x.append(el("td", {}, a), el("td", { class: "v" }, b)); t.append(x); };
    tr(r.cost.total === r.cost.base ? "BUFF lowest listing" : "BUFF cost (est.)", money(r.cost.total, W));
    tr("Sell at (undercut)", money(r.conservative.buyer, W));
    tr("Wallet credit", money(r.conservative.seller, W));
    tr("Wallet-value gain", `${money(r.gain, W)}  ${pct(r.roiBp)}`, r.gain > 0 ? "pos" : "neg");
    tr("Break-even Steam price", money(r.breakEven, W));
    out.append(t);
  }
  input.addEventListener("input", recompute);
  document.documentElement.appendChild(host);
  check();
  new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
})();
