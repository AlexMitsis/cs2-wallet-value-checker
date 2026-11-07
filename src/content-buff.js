/* Read-only hover popup on buff.market. It only reads the card you hover (exact name from the card's
   link, price from the card) and never clicks, buys or modifies anything on the page. */
(() => {
  const { nameFromBuffHref, parseBuffPrice, evaluate, money, pct, pageSupport } = globalThis.BMX;
  const CARD = 'a[href*="/market/goods/cs2/"]';

  const host = document.createElement("div");
  host.id = "bmx-host";
  host.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;display:none;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
    .p{width:300px;background:#11161d;color:#e6edf3;border:1px solid #3b4757;border-radius:4px;padding:10px 12px;
       font:12px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5)}
    .n{font-weight:600;font-size:13px;margin-bottom:6px;word-break:break-word}
    table{width:100%;border-collapse:collapse} td{padding:1px 0} td.v{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,monospace}
    .b{font-weight:700} .sep td{border-top:1px solid #3b4757;padding-top:3px}
    .pos{color:#3fb950} .neg{color:#f85149} .m{color:#8b949e;font-size:11px}
    .w{margin:6px 0 0;padding-left:16px;color:#d29922;font-size:11px} .w li{margin:1px 0}
    .err{color:#f85149} .pw{color:#d29922;font-size:11px;margin-bottom:6px} button{margin-top:8px;width:100%;background:#1f6feb;color:#fff;border:0;border-radius:4px;padding:5px;cursor:pointer;font:600 12px system-ui}
    a{color:#58a6ff}
    .gain{margin-top:8px;padding:7px 10px;border-radius:4px;border:1px solid;display:flex;align-items:center;justify-content:space-between;gap:8px}
    .gain.pos{background:rgba(63,185,80,.12);border-color:rgba(63,185,80,.45)}
    .gain.neg{background:rgba(248,81,73,.12);border-color:rgba(248,81,73,.45)}
    .gain .gl{color:#8b949e;font-size:11px;font-weight:600}
    .gain .gv{display:flex;align-items:center;font:700 17px/1.2 ui-monospace,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
    .gain .gs{width:1px;height:1em;margin:0 8px;background:currentColor;opacity:.45}
    /* open: 120ms fade + slight lift; close: 90ms fade. Fast enough to feel instant, smooth enough not to pop. */
    .p{opacity:0;transform:translateY(4px) scale(.985);transform-origin:top left;
       transition:opacity 120ms cubic-bezier(.2,0,0,1),transform 120ms cubic-bezier(.2,0,0,1)}
    .p.on{opacity:1;transform:none}
    .p.off{transition-duration:90ms;transition-timing-function:cubic-bezier(.4,0,1,1)}
    .p.swap>*:not(.ld){animation:in 100ms ease-out}
    /* loader: appears only if loading takes >120ms, so cached results never flash a spinner */
    .ld{display:flex;align-items:center;gap:7px;margin-top:6px;color:#8b949e;font-size:11px;animation:in 120ms ease-out 120ms both}
    .sp{flex:none;width:11px;height:11px;border:2px solid #3b4757;border-top-color:#58a6ff;border-radius:50%;animation:spin .7s linear infinite}
    .ld.q .sp{border-top-color:#d29922}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes in{from{opacity:0}to{opacity:1}}
    @media (prefers-reduced-motion: reduce){
      .p{transform:none;transition:opacity 80ms linear} .p.swap>*:not(.ld){animation:none}
    }
  </style><div class="p" id="p"></div>`;
  const panel = shadow.getElementById("p");
  document.documentElement.appendChild(host);

  let timer = 0, current = null, overPopup = false, seq = 0, hideTimer = 0, countdown = 0;

  function el(tag, attrs = {}, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text; // textContent only: item names are never parsed as HTML
    return e;
  }
  function row(label, value, cls = "") {
    const tr = el("tr", cls ? { class: cls } : {});
    tr.append(el("td", {}, label), el("td", { class: "v" }, value));
    return tr;
  }

  // Visual box of a card (the <a> may be inline; its first child is the actual tile).
  function box(card) {
    const inner = card.firstElementChild;
    const r = (inner || card).getBoundingClientRect();
    return r.width ? r : card.getBoundingClientRect();
  }

  // Place the popup over the neighbouring card in the same row: aligned to the next card's left edge,
  // or, for the last card in a row, to the previous card's right edge. Falls back to beside the card.
  function place(card) {
    const r = box(card);
    host.style.display = "block";
    const w = panel.offsetWidth || 326, h = panel.offsetHeight || 260;
    let next = null, prev = null;
    for (const other of document.querySelectorAll(CARD)) {
      if (other === card) continue;
      const o = box(other);
      if (Math.abs(o.top - r.top) > 4 || !o.width) continue; // same row only
      if (o.left >= r.right && (!next || o.left < next.left)) next = o;
      if (o.right <= r.left && (!prev || o.right > prev.right)) prev = o;
    }
    let left;
    if (next && next.left + w <= window.innerWidth - 4) left = next.left;
    else if (prev && prev.right - w >= 4) left = prev.right - w;
    else left = r.right + 8 + w <= window.innerWidth ? r.right + 8 : r.left - w - 8;
    left = Math.min(Math.max(4, left), window.innerWidth - w - 4);
    const top = Math.min(Math.max(4, r.top), Math.max(4, window.innerHeight - h - 8));
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  }
  function open() {
    clearTimeout(hideTimer);
    if (panel.classList.contains("on")) return; // already visible: just swap content, no re-animation
    panel.classList.remove("off");
    void panel.offsetWidth; // commit the hidden state so the transition runs
    panel.classList.add("on");
  }
  function hide() {
    current = null;
    clearInterval(countdown);
    if (host.style.display === "none") return;
    panel.classList.remove("on");
    panel.classList.add("off");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { host.style.display = "none"; panel.classList.remove("off"); }, 100);
  }

  function setLoading(stage, startsAt) {
    clearInterval(countdown);
    let ld = panel.querySelector(".ld");
    if (!ld) {
      ld = el("div", { class: "ld", role: "status", "aria-live": "polite" });
      ld.append(el("span", { class: "sp", "aria-hidden": "true" }), el("span"));
      panel.append(ld);
    }
    const msg = ld.lastChild;
    if (stage === "queued" && startsAt) {
      ld.classList.add("q");
      const tick = () => {
        const secs = Math.ceil((startsAt - Date.now()) / 1000);
        if (secs <= 0) { clearInterval(countdown); ld.classList.remove("q"); msg.textContent = "Fetching Steam price…"; return; }
        msg.textContent = `Waiting for a Steam lookup slot (rate limit) · ${secs}s`;
      };
      tick();
      countdown = setInterval(tick, 250);
    } else {
      ld.classList.remove("q");
      msg.textContent = "Fetching Steam price…";
    }
  }

  function readCard(card) {
    const name = nameFromBuffHref(card.getAttribute("href"));
    // The "(…$xx.xx)" next to the price is a currency conversion of the BUFF price (despite its
    // "steam-price" class) — it is NOT a Steam price and is ignored.
    const priceEl = card.querySelector(".user-price");
    let buff = null, error = null;
    try {
      if (!priceEl) throw new Error("price element not found on card");
      buff = parseBuffPrice(priceEl.textContent);
    } catch (e) { error = e.message; }
    const page = pageSupport(location.pathname, card.getAttribute("href"));
    return { name, buff, error, page, href: new URL(card.getAttribute("href"), location.origin).href };
  }

  function render(info, res) {
    if (!res) panel.classList.remove("swap");
    panel.replaceChildren(el("div", { class: "n" }, info.name));
    if (info.page.level === "unsupported") {
      panel.append(el("div", { class: "err" }, `Not supported here (${info.page.label}): ${info.page.reason}`),
        el("div", { class: "m" }, "No Steam lookup was made and nothing was saved."));
      return;
    }
    if (info.page.level !== "supported") panel.append(el("div", { class: "pw" }, `⚠ ${info.page.label}: ${info.page.reason}`));
    if (info.error) { panel.append(el("div", { class: "err" }, `Couldn't read BUFF price: ${info.error}`)); return; }
    if (!res) {
      panel.append(el("div", { class: "m" }, `BUFF lowest listing ${money(info.buff.cents, info.buff.currency)}`));
      setLoading("fetching");
      return;
    }
    clearInterval(countdown);
    panel.classList.remove("swap");
    void panel.offsetWidth;
    panel.classList.add("swap");
    if (!res.ok) {
      const until = res.cooldownUntil ? ` (until ${new Date(res.cooldownUntil).toLocaleTimeString()})` : "";
      panel.append(el("div", { class: "err" }, `Steam lookup failed: ${res.error}${until}`));
      return;
    }
    const { steam, fx, settings: s } = res;
    if (steam.status === "not_found") {
      panel.append(el("div", { class: "err" }, "Steam has no listing for this exact name (or no active sell listings)."));
      return;
    }
    const W = s.walletCurrency;
    const r = evaluate(info.name, info.buff, steam, s, fx.rates || {});
    const t = el("table");
    if (r.cost) {
      // One row unless the user configured fees: "52,60 € ≈ $58.76" (converted) or "$58.76".
      const listed = r.cost.converted
        ? `${money(info.buff.cents, info.buff.currency)} ≈ ${money(r.cost.base, W)}`
        : money(r.cost.base, W);
      const extra = r.cost.markup + r.cost.pctFee + r.cost.fixed;
      t.append(row("BUFF lowest listing", listed, extra ? "" : "b"));
      if (extra) {
        t.append(row("  + your fees/markup", money(extra, W)));
        t.append(row("BUFF cost (est.)", money(r.cost.total, W), "b"));
      }
    } else {
      t.append(row("BUFF lowest listing", money(info.buff.cents, info.buff.currency), "b"));
    }
    t.append(row("Steam lowest ask", money(steam.lowestAsk, W), "sep"));
    t.append(row("Steam 24h median / sales", `${money(steam.median24h, W)} / ${steam.volume24h ?? 0}`));
    if (r.conservative) {
      t.append(row(`Sell at (${r.conservative === r.scenarios.median ? "median" : "undercut"})`, money(r.conservative.buyer, W)));
      t.append(row("  − Steam + CS2 fees", money(-(r.conservative.steamFee + r.conservative.publisherFee), W)));
      t.append(row("Wallet credit", money(r.conservative.seller, W), "b"));
      t.append(row("Break-even Steam price", money(r.breakEven, W)));
    }
    panel.append(t);
    if (r.conservative) {
      const cls = r.gain > 0 ? "pos" : "neg";
      const g = el("div", { class: `gain ${cls}` });
      const v = el("span", { class: `gv ${cls}` }, money(r.gain, W));
      v.append(el("span", { class: "gs", "aria-hidden": "true" }), el("span", {}, pct(r.roiBp)));
      g.append(el("span", { class: "gl" }, "Wallet-value gain"), v);
      panel.append(g);
    }
    if (r.warnings.length) {
      const ul = el("ul", { class: "w" });
      for (const w of r.warnings) ul.append(el("li", {}, w));
      panel.append(ul);
    }
    const age = Math.round((Date.now() - steam.fetchedAt) / 1000);
    const meta = el("div", { class: "m" },
      `Steam ${steam.cached ? "cached" : "fetched"} ${age}s ago · fees ${r.feeRule}` +
      (fx.effectiveDate ? ` · ECB ${fx.effectiveDate}` : fx.error ? ` · FX error: ${fx.error}` : ""));
    panel.append(meta);
    const link = el("a", { href: "#" }, res.saved ? "Saved · open results ranking"
      : res.removed ? "No longer profitable — removed from results · open results"
      : res.settings?.saveResults ? "Not saved (no profit) · open results ranking" : "Open results ranking");
    link.addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: "openResults" }); });
    panel.append(el("div", { class: "m" }), link);
    const btn = el("button", {}, "Verify on Steam ↗");
    btn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "openVerify", name: info.name, buff: info.buff, href: info.href,
      api: { lowestAsk: steam.lowestAsk, currency: steam.currency, fetchedAt: steam.fetchedAt } }));
    panel.append(btn);
  }

  async function show(card) {
    const info = readCard(card);
    if (!info.name) return;
    current = card;
    const my = ++seq;
    render(info, null);
    place(card);
    open();
    if (info.error || info.page.level === "unsupported") return; // never look up or save unsupported prices
    const res = await new Promise((resolve) => {
      let done = false;
      let port;
      try { port = chrome.runtime.connect({ name: "lookup" }); } catch (e) { resolve({ ok: false, error: String(e.message || e) }); return; }
      port.onMessage.addListener((m) => {
        if (m.type === "progress" && my === seq && current === card) setLoading(m.stage, m.startsAt);
        if (m.type === "result") { done = true; resolve(m.res); port.disconnect(); }
      });
      port.onDisconnect.addListener(() => { if (!done) resolve({ ok: false, error: chrome.runtime.lastError?.message || "extension reloaded — refresh the page" }); });
      port.postMessage({ name: info.name, buff: info.buff, href: info.href, page: info.page });
    });
    if (my !== seq || current !== card) return; // user moved on
    render(info, res);
    place(card);
  }

  document.addEventListener("mouseover", (e) => {
    const card = e.target instanceof Element ? e.target.closest(CARD) : null;
    if (!card || card === current) return;
    clearTimeout(timer);
    chrome.storage.sync.get({ hoverDelayMs: 500 }).then(({ hoverDelayMs }) => {
      timer = setTimeout(() => { if (card.matches(":hover")) show(card); }, hoverDelayMs);
    });
  }, { passive: true });

  document.addEventListener("mouseout", (e) => {
    const card = e.target instanceof Element ? e.target.closest(CARD) : null;
    if (!card) return;
    const to = e.relatedTarget;
    if (to instanceof Element && card.contains(to)) return;
    clearTimeout(timer);
    setTimeout(() => { if (!overPopup && current === card && !card.matches(":hover")) hide(); }, 150);
  }, { passive: true });

  host.addEventListener("mouseenter", () => { overPopup = true; });
  host.addEventListener("mouseleave", () => { overPopup = false; if (current && !current.matches(":hover")) hide(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  window.addEventListener("scroll", () => { if (!overPopup) hide(); }, { passive: true });

})();
