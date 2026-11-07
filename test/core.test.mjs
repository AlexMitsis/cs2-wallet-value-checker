// node --test test/   (no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = { URL };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../src/core.js", import.meta.url), "utf8"), ctx);
const B = ctx.BMX;
const S = { ...B.DEFAULT_SETTINGS };

test("fee calculator matches the reference table", () => {
  const t = JSON.parse(readFileSync(new URL("./python-fee-table.json", import.meta.url), "utf8"));
  for (const [s, b] of Object.entries(t.forward)) assert.equal(B.feeForward(Number(s)).buyer, b, `forward ${s}`);
  for (const [b, s] of Object.entries(t.inverse)) assert.equal(B.feeInverse(Number(b)).seller, s, `inverse ${b}`);
});

test("fee edge cases", () => {
  assert.equal(B.feeForward(1).buyer, 3);
  assert.equal(B.feeInverse(2), null);
  assert.equal(B.feeInverse(10000).seller, 8697); // not 8500 (the 15%-of-buyer shortcut)
  const be = B.breakEvenBuyer(7000);
  assert.ok(B.feeInverse(be).seller >= 7000 && B.feeInverse(be - 1).seller < 7000);
});

test("Steam price formats observed live on 2026-11-01", () => {
  assert.equal(B.parseSteamPrice("$1,539.62", "USD"), 153962);
  assert.equal(B.parseSteamPrice("$0.19", "USD"), 19);
  assert.equal(B.parseSteamPrice("£1,150.00", "GBP"), 115000);
  assert.equal(B.parseSteamPrice("1 379,62€", "EUR"), 137962);
  assert.equal(B.parseSteamPrice("0,18€", "EUR"), 18);
  assert.equal(B.parseSteamPrice("5,--€", "EUR"), 500);
  for (const [txt, ccy] of [["1 379,62€", "USD"], ["$1.00", "EUR"], ["", "USD"], ["$1.5", "USD"], ["¥100", "USD"]]) {
    assert.throws(() => B.parseSteamPrice(txt, ccy), undefined, `${txt} as ${ccy}`);
  }
});

test("priceoverview: success with no price is NOT a price", () => {
  assert.equal(B.parsePriceOverview({ success: true }, "USD").status, "not_found");
  assert.equal(B.parsePriceOverview({ success: false }, "USD").status, "error");
  const r = B.parsePriceOverview({ success: true, lowest_price: "$4.09" }, "USD");
  assert.deepEqual([r.lowestAsk, r.median24h, r.volume24h], [409, null, 0]);
  const v = B.parsePriceOverview({ success: true, lowest_price: "0,18€", volume: "63,696", median_price: "0,18€" }, "EUR");
  assert.equal(v.volume24h, 63696);
});

test("BUFF card price and exact name from the card link", () => {
  assert.deepEqual({ ...B.parseBuffPrice("€16.97(") }, { currency: "EUR", cents: 1697 });
  assert.deepEqual({ ...B.parseBuffPrice("$1,234.5") }, { currency: "USD", cents: 123450 });
  assert.throws(() => B.parseBuffPrice("¥100"));
  assert.equal(B.nameFromBuffHref("/market/goods/cs2/StatTrak%E2%84%A2%20USP-S%20%7C%20Stainless%20%28Field-Tested%29"),
    "StatTrak™ USP-S | Stainless (Field-Tested)");
  assert.equal(B.nameFromBuffHref("https://evil.example/market/goods/cs2/x"), null);
  assert.equal(B.nameFromBuffHref("/market/all"), null);
});

test("evaluate: spec example shape, conservative choice, conversions", () => {
  const steam = { status: "ok", currency: "USD", lowestAsk: 10001, median24h: 9500, volume24h: 40 };
  const r = B.evaluate("AK-47 | Redline (Field-Tested)", { currency: "USD", cents: 7000 }, steam, S, {});
  assert.equal(r.conservative.label, "24h median sale"); // lower credit than undercut ask wins
  assert.equal(r.conservative.seller, B.feeInverse(9500).seller);
  assert.equal(r.gain, r.conservative.seller - 7000);
  // EUR BUFF price -> USD wallet at ECB 1.10 with 2% markup and 3% fee
  const r2 = B.evaluate("x", { currency: "EUR", cents: 1000 }, steam, { ...S, fxMarkupPct: 2, buffFeePct: 3 }, { USD: 1.1 });
  assert.equal(r2.cost.base, 1100);
  assert.equal(r2.cost.markup, 22);
  assert.equal(r2.cost.pctFee, Math.round(1122 * 0.03));
  // missing FX -> no comparison
  const r3 = B.evaluate("x", { currency: "GBP", cents: 1000 }, steam, S, { USD: 1.1 });
  assert.equal(r3.gain, undefined);
  assert.ok(r3.warnings[0].includes("No FX rate"));
});

test("evaluate warnings: liquidity and premiums", () => {
  const w = (vol, name = "x") => B.evaluate(name, { currency: "USD", cents: 100 }, { status: "ok", currency: "USD", lowestAsk: 200, median24h: null, volume24h: vol }, S, {}).warnings.join(" | ");
  assert.match(w(0), /No Steam sales in the last 24h/);
  assert.match(w(3), /thin liquidity/);
  assert.match(w(null), /volume unknown/);
  assert.match(w(50, "★ Karambit | Doppler (Factory New)"), /premiums are not priced/);
});

test("typed prices and variant description", () => {
  assert.equal(B.parseTypedPrice("28,63"), 2863);
  assert.equal(B.parseTypedPrice("€1 234,50"), 123450);
  assert.equal(B.parseTypedPrice("1,234.50"), 123450);
  assert.equal(B.parseTypedPrice("12"), 1200);
  assert.equal(B.parseTypedPrice("abc"), null);
  const v = B.describeVariant("★ StatTrak™ Karambit | Doppler (Factory New)");
  assert.deepEqual({ ...v }, { base: "Karambit | Doppler", exterior: "Factory New", quality: "StatTrak™", star: true });
  assert.equal(B.describeVariant("Souvenir AWP | Safari Mesh (Field-Tested)").quality, "Souvenir");
});

const steamOk = (ask, vol = 40, med = null, fetchedAt = 1000) => ({ status: "ok", currency: "USD", lowestAsk: ask, median24h: med, volume24h: vol, fetchedAt });
const rec = (name, buffCents, ask, extra = {}) =>
  B.buildRecord({ name, href: "https://buff.market/x", buff: { currency: "USD", cents: buffCents }, steam: steamOk(ask, extra.vol ?? 40),
    fx: { rates: {}, effectiveDate: "2026-10-30" }, settings: S, now: extra.now ?? 2000, previous: extra.previous });

test("buildRecord keeps separate timestamps and lookup count", () => {
  const r1 = rec("A", 1000, 1500, { now: 5000 });
  assert.equal(r1.buffSeenAt, 5000);
  assert.equal(r1.steamFetchedAt, 1000); // Steam time is when Steam answered, not when you hovered
  assert.equal(r1.firstSeenAt, 5000);
  assert.equal(r1.lookups, 1);
  const r2 = rec("A", 900, 1500, { now: 9000, previous: r1 });
  assert.equal(r2.firstSeenAt, 5000);
  assert.equal(r2.lookups, 2);
  assert.equal(r2.buff.cents, 900);
  assert.equal(r1.credit, B.feeInverse(1499).seller);
  assert.equal(r1.gain, r1.credit - 1000);
});

test("rankResults sorts, filters and puts missing values last", () => {
  const rs = [rec("Low", 1000, 1100), rec("High", 1000, 2000), rec("Thin", 1000, 3000, { vol: 2 }),
    { ...rec("NoCost", 1000, 1500), cost: null, gain: null, roiBp: null }];
  assert.deepEqual(rankResults(rs).map((r) => r.name), ["Thin", "High", "Low", "NoCost"]);
  assert.deepEqual(rankResults(rs, { hideThin: true }).map((r) => r.name), ["High", "Low", "NoCost"]);
  assert.deepEqual(rankResults(rs, { minSales: 10, minRoiBp: 1 }).map((r) => r.name), ["High"]);
  assert.deepEqual(rankResults(rs, { query: "HIGH" }).map((r) => r.name), ["High"]);
  assert.deepEqual(rankResults(rs, { maxAgeMin: 1, now: 1000 + 61000 }).map((r) => r.name), []);
});
function rankResults(rs, o) { return [...B.rankResults(rs, o)]; }

test("CSV has ISO timestamps and blocks formula injection", () => {
  const csv = B.resultsCsv([rec("=HYPERLINK(\"x\")", 1000, 1500)]);
  const [head, line] = csv.trim().split("\n");
  assert.ok(head.startsWith("market_hash_name,buff_seen_at_utc,steam_fetched_at_utc"));
  assert.ok(line.startsWith(`"'=HYPERLINK(""x"")"`));
  assert.ok(line.includes("1970-01-01T00:00:02.000Z"));
});

test("pageSupport classifies BUFF tabs as verified 2026-11-01", () => {
  const lvl = (path, href = "/market/goods/cs2/AK-47%20%7C%20Redline%20(Field-Tested)") => B.pageSupport(path, href).level;
  assert.equal(lvl("/market/all"), "supported");
  assert.equal(lvl("/market/buy_order"), "unsupported");
  assert.equal(lvl("/market/all", "/market/goods/cs2/Clutch%20Case?tab=Order"), "unsupported"); // card-level signal
  assert.equal(lvl("/market/sticker_combos"), "unsupported");
  assert.equal(lvl("/market/gold_stickers"), "unsupported");
  assert.equal(lvl("/market/best_deals"), "listing");
  assert.equal(lvl("/market/popular"), "listing");
  assert.equal(lvl("/market/something_new"), "unverified");
  assert.equal(B.nameFromBuffHref("/market/goods/cs2/Clutch%20Case?tab=Order"), "Clutch Case");
});

test("positive-only storage and profit format", () => {
  assert.equal(B.isProfitable(rec("P", 1000, 1500)), true);
  assert.equal(B.isProfitable(rec("L", 1000, 1100)), false); // loss after fees
  assert.equal(B.isProfitable({ gain: 0 }), false);
  assert.equal(B.isProfitable({ gain: null }), false);
  assert.equal(B.formatProfit(412, 503, "USD"), "+4.12% (+5.03$)");
  assert.equal(B.formatProfit(412, 503, "EUR"), "+4.12% (+5,03 €)");
  assert.equal(B.formatProfit(-250, -12, "USD"), "−2.50% (−0.12$)");
  assert.equal(B.formatProfit(null, null, "USD"), "—");
});

test("profit sort uses the percentage only; 'fetched' sorts by Steam fetch time", () => {
  // big % on a cheap item vs bigger $ gain at a smaller % — percentage wins
  const cheap = { ...rec("Cheap", 60, 120), roiBp: 6000, gain: 36 };
  const pricey = { ...rec("Pricey", 5000, 7000), roiBp: 3000, gain: 1500 };
  assert.deepEqual(B.rankResults([pricey, cheap], { sort: "profit" }).map((r) => r.name), ["Cheap", "Pricey"]);
  const old = { ...rec("Old", 100, 200), steamFetchedAt: 1 };
  const fresh = { ...rec("Fresh", 100, 200), steamFetchedAt: 9 };
  assert.deepEqual(B.rankResults([old, fresh], { sort: "fetched" }).map((r) => r.name), ["Fresh", "Old"]);
});
