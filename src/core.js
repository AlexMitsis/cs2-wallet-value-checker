// Shared pure logic for the BUFF -> Steam extension. Classic script: defines globalThis.BMX so it can be
// loaded by content scripts (manifest list), the service worker (importScripts) and Node tests (vm).
// All money math uses integer minor units (cents); never binary floating point for amounts.
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- Steam fees
  // Integer fee model (rule version below); golden values in test/python-fee-table.json were produced by an
  // independent Python implementation. 5% Steam + 10% CS2 are Valve-published;
  // the per-component floor / 1-cent minimum is community-observed sell-dialog behaviour (ESTIMATED).
  const FEE_RULES = { version: "steam-cs2-2026.11-a", steamPct: 5, publisherPct: 10, minFee: 1, minSeller: 1 };

  function feeForward(seller) {
    if (!Number.isInteger(seller) || seller < FEE_RULES.minSeller) throw new Error("seller must be int >= 1");
    // floor(seller * pct / 100) in exact integer arithmetic
    const steam = Math.max(Math.floor((seller * FEE_RULES.steamPct) / 100), FEE_RULES.minFee);
    const publisher = Math.max(Math.floor((seller * FEE_RULES.publisherPct) / 100), FEE_RULES.minFee);
    return { seller, steamFee: steam, publisherFee: publisher, buyer: seller + steam + publisher };
  }

  /** Largest seller credit whose buyer total <= buyer (null below the minimum listing price). */
  function feeInverse(buyer) {
    if (!Number.isInteger(buyer) || buyer < feeForward(FEE_RULES.minSeller).buyer) return null;
    let lo = FEE_RULES.minSeller, hi = buyer;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (feeForward(mid).buyer <= buyer) lo = mid; else hi = mid - 1;
    }
    return feeForward(lo);
  }

  /** Smallest buyer total that yields at least `requiredSeller` credit. */
  function breakEvenBuyer(requiredSeller) {
    return feeForward(Math.max(requiredSeller, FEE_RULES.minSeller)).buyer;
  }

  // ---------------------------------------------------------------- currencies & parsing
  const STEAM_CURRENCY_ID = { USD: 1, GBP: 2, EUR: 3 };
  const SYMBOL_TO_CCY = { "$": "USD", "€": "EUR", "£": "GBP" };

  /**
   * Parse Steam priceoverview strings for the currency requested:
   *   USD "$1,539.62"   GBP "£1,150.00"   EUR "1 379,62€" / "0,18€" / "1,--€"
   * Returns integer cents or throws (wrong locale/currency is an error, never a guess).
   */
  function parseSteamPrice(text, ccy) {
    if (typeof text !== "string") throw new Error("price missing");
    const s = text.replace(/[  ]/g, " ").trim();
    let m;
    if (ccy === "USD" && (m = s.match(/^\$(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(?: USD)?$/))) {
      return Number(m[1].replace(/,/g, "")) * 100 + Number(m[2]);
    }
    if (ccy === "GBP" && (m = s.match(/^£(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/))) {
      return Number(m[1].replace(/,/g, "")) * 100 + Number(m[2]);
    }
    if (ccy === "EUR" && (m = s.match(/^(\d{1,3}(?:[ .]\d{3})*|\d+),(\d{2}|--)\s?€$/))) {
      return Number(m[1].replace(/[ .]/g, "")) * 100 + (m[2] === "--" ? 0 : Number(m[2]));
    }
    throw new Error(`unrecognised ${ccy} price "${text}"`);
  }

  function parseCount(text) {
    if (text === undefined || text === null) return null;
    const n = Number(String(text).replace(/[,.\s]/g, ""));
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  /** Interpret a priceoverview JSON body. success:true with no lowest_price means "no such item / no listings". */
  function parsePriceOverview(body, ccy) {
    if (!body || body.success !== true) return { status: "error", error: "Steam returned success=false" };
    if (!("lowest_price" in body)) return { status: "not_found" };
    return {
      status: "ok",
      currency: ccy,
      lowestAsk: parseSteamPrice(body.lowest_price, ccy),
      median24h: "median_price" in body ? parseSteamPrice(body.median_price, ccy) : null,
      volume24h: "volume" in body ? parseCount(body.volume) : 0, // field absent => no sales in 24h
    };
  }

  /** BUFF card price text like "€16.97(" or "$1,234.50" -> { currency, cents }. */
  function parseBuffPrice(text) {
    const s = String(text || "").replace(/[()\s ]/g, "");
    const m = s.match(/^([$€£])(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/);
    if (!m) throw new Error(`unrecognised BUFF price "${text}"`);
    const cents = Number(m[2].replace(/,/g, "")) * 100 + Number((m[3] || "0").padEnd(2, "0"));
    return { currency: SYMBOL_TO_CCY[m[1]], cents };
  }

  /** Exact market_hash_name from a BUFF.Market goods link: /market/goods/cs2/<urlencoded name>. */
  function nameFromBuffHref(href) {
    const u = new URL(href, "https://buff.market");
    if (u.hostname !== "buff.market") return null;
    const m = u.pathname.match(/^\/market\/goods\/cs2\/([^/]+)\/?$/);
    if (!m) return null;
    const name = decodeURIComponent(m[1]);
    if (!name || name !== name.trim() || /[\u0000-\u001f]/.test(name)) return null;
    return name;
  }

  /** A price typed by the user: "28,63", "28.63", "€28,63", "1 234,50", "1,234.50" -> cents (or null). */
  function parseTypedPrice(text) {
    const s = String(text || "").replace(/[^0-9.,]/g, "");
    if (!s) return null;
    const m = s.match(/^(.*?)(?:[.,](\d{1,2}))?$/);
    const whole = m[1].replace(/[.,]/g, "");
    if (!/^\d+$/.test(whole)) return null;
    const cents = Number(whole) * 100 + Number((m[2] || "0").padEnd(2, "0"));
    return cents > 0 ? cents : null;
  }

  /** "StatTrak™ USP-S | Stainless (Field-Tested)" -> { base: "USP-S | Stainless", exterior, quality } */
  function describeVariant(name) {
    let rest = name.startsWith("★ ") ? name.slice(2) : name;
    let quality = "Normal";
    if (rest.startsWith("StatTrak™ ")) { quality = "StatTrak™"; rest = rest.slice(10); }
    else if (rest.startsWith("Souvenir ") && rest.includes(" | ")) { quality = "Souvenir"; rest = rest.slice(9); }
    const m = rest.match(/ \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/);
    return { base: m ? rest.slice(0, m.index) : rest, exterior: m ? m[1] : null, quality, star: name.startsWith("★ ") };
  }

  /**
   * Which BUFF.Market pages give a correct "cheapest sell listing" price on their cards.
   * Verified 2026-11-01 by comparing card prices with each item page's cheapest listing.
   *   supported   - card price = cheapest sell listing
   *   listing     - card price is one specific listing (may not be the cheapest; may carry a premium)
   *   unsupported - card price is not comparable (buy orders, sticker-premium listings): no lookup
   *   unverified  - page not checked yet
   */
  function pageSupport(pathname, cardHref) {
    let tab = "";
    try { tab = new URL(cardHref || "", "https://buff.market").searchParams.get("tab") || ""; } catch { /* ignore */ }
    if (tab.toLowerCase() === "order" || pathname.startsWith("/market/buy_order")) {
      return { level: "unsupported", label: "Recent Buy Orders",
        reason: "Prices on this tab are buy orders, not sell listings. Open All Items to compare." };
    }
    if (pathname.startsWith("/market/sticker_combos") || pathname.startsWith("/market/gold_stickers")) {
      return { level: "unsupported", label: "Sticker listings",
        reason: "These cards are stickered listings whose price includes a sticker premium that Steam's plain price doesn't. Open All Items to compare." };
    }
    if (pathname === "/market/all" || pathname === "/market/all/") {
      return { level: "supported", label: "All Items", reason: null };
    }
    if (pathname.startsWith("/market/best_deals") || pathname.startsWith("/market/popular")) {
      return { level: "listing", label: pathname.includes("popular") ? "Popular" : "Best Deals",
        reason: "This tab shows one specific listing, not always the cheapest; it may carry a float/pattern premium." };
    }
    return { level: "unverified", label: pathname,
      reason: "Prices on this page haven't been verified. All Items is the verified page." };
  }

  function steamListingUrl(name) {
    return "https://steamcommunity.com/market/listings/730/" + encodeURIComponent(name);
  }

  // ---------------------------------------------------------------- FX (ECB reference, via EUR)
  /** rates: { USD: 1.1172, GBP: 0.84, ... } = units per 1 EUR (EUR itself = 1). */
  function convertCents(cents, from, to, rates) {
    if (from === to) return cents;
    const per = (c) => (c === "EUR" ? 1 : rates[c]);
    if (!per(from) || !per(to)) return null;
    return Math.round((cents * per(to)) / per(from));
  }

  // ---------------------------------------------------------------- evaluation
  const PREMIUM_HINT = /(Doppler|Fade|Case Hardened|Marble Fade|Crimson Web|Slaughter|Lore|Gamma Doppler|Sticker Slab)/;

  /**
   * buff: { currency, cents }   steam: parsePriceOverview result   s: settings   rates: ECB per-EUR rates
   * Returns all figures in the wallet currency (minor units) plus warnings. Pure; no I/O.
   */
  function evaluate(name, buff, steam, s, rates) {
    const W = s.walletCurrency;
    const warnings = [];
    const out = { name, walletCurrency: W, warnings, feeRule: FEE_RULES.version + " (ESTIMATED)" };
    if (!steam || steam.status !== "ok") return out;

    // BUFF cost: lowest listing (not checkout total) + user's assumptions
    let base = convertCents(buff.cents, buff.currency, W, rates);
    if (base === null) { warnings.push(`No FX rate for ${buff.currency}->${W}; cannot compare.`); return out; }
    const converted = buff.currency !== W;
    const markup = converted ? Math.round((base * s.fxMarkupPct) / 100) : 0;
    const pctFee = Math.round(((base + markup) * s.buffFeePct) / 100);
    const cost = base + markup + pctFee + Math.round(s.buffFixedFeeCents);
    out.cost = { base, markup, pctFee, fixed: Math.round(s.buffFixedFeeCents), total: cost, converted, from: buff.currency };

    // Sell scenarios (fees computed independently for each)
    const scen = {};
    const target = steam.lowestAsk - Math.max(0, s.undercutTicks);
    const u = feeInverse(target);
    if (u) scen.undercut = { label: `Undercut lowest ask by ${s.undercutTicks}¢`, ...u };
    if (steam.median24h) {
      const m = feeInverse(steam.median24h);
      if (m) scen.median = { label: "24h median sale", ...m };
    }
    out.scenarios = scen;
    const usable = Object.values(scen);
    if (!usable.length) { warnings.push("Steam price below the minimum listing price."); return out; }
    const cons = usable.reduce((a, b) => (b.seller < a.seller ? b : a));
    out.conservative = cons;
    out.gain = cons.seller - cost;
    out.roiBp = cost > 0 ? Math.round((out.gain * 10000) / cost) : null;
    out.ratioPpm = steam.lowestAsk > 0 ? Math.round((cost * 1e6) / steam.lowestAsk) : null;
    out.breakEven = breakEvenBuyer(cost);

    if (typeof steam.volume24h !== "number") warnings.push("Steam sales volume unknown.");
    else if (steam.volume24h === 0) warnings.push("No Steam sales in the last 24h — may be hard to sell.");
    else if (steam.volume24h < 5) warnings.push(`Only ${steam.volume24h} Steam sales in 24h — thin liquidity.`);
    if (!steam.median24h) warnings.push("No 24h median: headline uses the undercut ask only.");
    if (PREMIUM_HINT.test(name)) warnings.push("Pattern/phase/float premiums are not priced — compare the specific listing.");
    if (converted) warnings.push(`BUFF price converted ${buff.currency}->${W} at the ECB reference rate${s.fxMarkupPct ? ` + ${s.fxMarkupPct}% markup` : ""}.`);
    return out;
  }

  // ---------------------------------------------------------------- formatting
  function money(cents, ccy) {
    if (cents === null || cents === undefined || Number.isNaN(cents)) return "—";
    const sign = cents < 0 ? "−" : "";
    const v = (Math.abs(cents) / 100).toFixed(2);
    return ccy === "EUR" ? `${sign}${v.replace(".", ",")} €` : `${sign}${ccy === "GBP" ? "£" : "$"}${v}`;
  }
  function pct(bp) {
    if (bp === null || bp === undefined) return "—";
    return `${bp > 0 ? "+" : bp < 0 ? "−" : ""}${(Math.abs(bp) / 100).toFixed(2)}%`;
  }

  // ---------------------------------------------------------------- saved results (one record per item)
  const RESULT_PREFIX = "r:";
  const MAX_RESULTS = 5000;

  /** Snapshot of one lookup, with figures exactly as computed at that moment. */
  function buildRecord({ name, href, buff, steam, fx, settings, now, previous, page }) {
    const r = evaluate(name, buff, steam, settings, (fx && fx.rates) || {});
    return {
      name, href,
      buffSeenAt: now, // when you hovered and the card price was read
      steamFetchedAt: steam.fetchedAt, // when Steam actually answered (older if served from cache)
      firstSeenAt: previous?.firstSeenAt ?? now,
      lookups: (previous?.lookups ?? 0) + 1,
      buff: { currency: buff.currency, cents: buff.cents },
      steam: { currency: steam.currency, lowestAsk: steam.lowestAsk, median24h: steam.median24h, volume24h: steam.volume24h },
      walletCurrency: settings.walletCurrency,
      fxDate: fx?.effectiveDate ?? null,
      cost: r.cost?.total ?? null,
      sellAt: r.conservative?.buyer ?? null,
      sellBasis: r.conservative ? (r.conservative === r.scenarios.median ? "median" : "undercut") : null,
      credit: r.conservative?.seller ?? null,
      gain: r.gain ?? null,
      roiBp: r.roiBp ?? null,
      ratioPpm: r.ratioPpm ?? null,
      thin: typeof steam.volume24h !== "number" || steam.volume24h < 5,
      premium: PREMIUM_HINT.test(name),
      feeRule: FEE_RULES.version,
      assumptions: { buffFeePct: settings.buffFeePct, buffFixedFeeCents: settings.buffFixedFeeCents,
                     fxMarkupPct: settings.fxMarkupPct, undercutTicks: settings.undercutTicks },
      warnings: r.warnings,
      page: page ? { level: page.level, label: page.label } : null,
    };
  }

  // "profit" sorts by the percentage only (wallet-value ROI).
  const SORTS = {
    profit: (r) => r.roiBp, roi: (r) => r.roiBp, cost: (r) => r.cost, sales: (r) => r.steam.volume24h,
    fetched: (r) => r.steamFetchedAt,
  };

  /** Only records with a positive wallet-value gain are kept in the Results table. */
  function isProfitable(rec) {
    return typeof rec?.gain === "number" && rec.gain > 0;
  }

  /** "+4.12% (+5.03$)" — percentage first, absolute gain in the wallet currency after. */
  function formatProfit(roiBp, gainCents, ccy) {
    if (roiBp === null || roiBp === undefined || gainCents === null || gainCents === undefined) return "—";
    const sign = gainCents > 0 ? "+" : gainCents < 0 ? "−" : "";
    const v = (Math.abs(gainCents) / 100).toFixed(2);
    const amount = ccy === "EUR" ? `${v.replace(".", ",")} €` : `${v}${ccy === "GBP" ? "£" : "$"}`;
    return `${pct(roiBp)} (${sign}${amount})`;
  }

  /** Filter + sort saved records. Records with missing sort values go last; ties broken by name. */
  function rankResults(records, o = {}) {
    const now = o.now ?? Date.now();
    const out = records.filter((r) => {
      if (o.currency && r.walletCurrency !== o.currency) return false;
      if (o.hideThin && r.thin) return false;
      if (o.hidePremium && r.premium) return false;
      if (o.minSales != null && !(r.steam.volume24h >= o.minSales)) return false;
      if (o.minCost != null && !(r.cost >= o.minCost)) return false;
      if (o.maxCost != null && !(r.cost <= o.maxCost)) return false;
      if (o.minRoiBp != null && !(r.roiBp >= o.minRoiBp)) return false;
      if (o.maxAgeMin != null && now - Math.min(r.buffSeenAt, r.steamFetchedAt) > o.maxAgeMin * 60000) return false;
      if (o.query && !r.name.toLowerCase().includes(o.query.toLowerCase())) return false;
      return true;
    });
    const key = SORTS[o.sort || "profit"] || SORTS.profit;
    const dir = o.asc ? 1 : -1;
    return out.sort((a, b) => {
      const x = key(a), y = key(b);
      if (x === null || x === undefined) return y === null || y === undefined ? a.name.localeCompare(b.name) : 1;
      if (y === null || y === undefined) return -1;
      return x === y ? a.name.localeCompare(b.name) : (x - y) * dir;
    });
  }

  /** CSV with spreadsheet formula-injection protection. */
  function resultsCsv(records) {
    const safe = (v) => {
      if (v === null || v === undefined) return "";
      let s = String(v);
      if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const c = (x) => (x === null || x === undefined ? null : (x / 100).toFixed(2));
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    const head = ["market_hash_name", "buff_seen_at_utc", "steam_fetched_at_utc", "first_seen_at_utc", "wallet_currency",
      "buff_price", "buff_currency", "buff_cost_est", "steam_lowest_ask", "steam_median_24h", "steam_sales_24h",
      "sell_at", "sell_basis", "wallet_credit", "gain", "roi_pct", "thin_liquidity", "premium_unpriced", "fx_date",
      "fee_rule", "captured_on_page", "buff_link"];
    const rows = records.map((r) => [r.name, iso(r.buffSeenAt), iso(r.steamFetchedAt), iso(r.firstSeenAt), r.walletCurrency,
      c(r.buff.cents), r.buff.currency, c(r.cost), c(r.steam.lowestAsk), c(r.steam.median24h), r.steam.volume24h,
      c(r.sellAt), r.sellBasis, c(r.credit), c(r.gain), r.roiBp === null ? null : (r.roiBp / 100).toFixed(2), r.thin,
      r.premium, r.fxDate, r.feeRule, r.page ? r.page.label : null, r.href]);
    return [head, ...rows].map((row) => row.map(safe).join(",")).join("\n") + "\n";
  }

  const DEFAULT_SETTINGS = {
    walletCurrency: "USD",
    buffFeePct: 0,
    buffFixedFeeCents: 0,
    fxMarkupPct: 0,
    undercutTicks: 1,
    hoverDelayMs: 500,
    cacheMinutes: 5,
    maxPerMinute: 12,
    saveResults: true,
  };

  root.BMX = {
    FEE_RULES, feeForward, feeInverse, breakEvenBuyer, STEAM_CURRENCY_ID, parseSteamPrice, parseCount,
    parsePriceOverview, parseBuffPrice, parseTypedPrice, describeVariant, nameFromBuffHref,
    RESULT_PREFIX, MAX_RESULTS, buildRecord, rankResults, resultsCsv, pageSupport, isProfitable, formatProfit, steamListingUrl, convertCents, evaluate, money, pct,
    DEFAULT_SETTINGS,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
