// Loads the real service worker (src/background.js) in a sandbox with mocked chrome.* and fetch,
// then drives a lookup end to end: Steam parse -> evaluate -> save only if profitable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = new URL("../src/", import.meta.url);
const ECB_XML = `<Cube><Cube time="2026-10-30"><Cube currency="USD" rate="1.1172"/></Cube></Cube>`;

function makeWorker(steamBody) {
  const area = () => {
    const data = {};
    return {
      data,
      async get(keys) {
        if (keys === null) return { ...data };
        if (typeof keys === "string") return keys in data ? { [keys]: data[keys] } : {};
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
        return { ...keys, ...Object.fromEntries(Object.keys(keys).filter((k) => k in data).map((k) => [k, data[k]])) };
      },
      async set(obj) { Object.assign(data, obj); },
      async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
    };
  };
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const calls = [];
  const ctx = {
    URL, console, setTimeout, clearTimeout, Promise, Date, Math, Number, JSON, Object, Array, String, Error,
    chrome: {
      storage: { sync: area(), session: area(), local: area() },
      runtime: { onMessage: on("message"), onConnect: on("connect"), getURL: (p) => `chrome-extension://x/${p}`,
                 openOptionsPage: async () => {} },
      tabs: { onRemoved: on("tabRemoved"), query: async () => [], create: async () => ({ id: 1 }), update: async () => {} },
      action: { onClicked: on("action") },
    },
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).includes("ecb.europa.eu")) return { ok: true, status: 200, text: async () => ECB_XML };
      return { ok: true, status: 200, json: async () => steamBody.current };
    },
  };
  ctx.self = ctx;
  ctx.importScripts = (f) => vm.runInContext(readFileSync(new URL(f, SRC), "utf8"), ctx);
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("background.js", SRC), "utf8"), ctx, { filename: "background.js" });
  const send = (msg) => new Promise((resolve) => listeners.message(msg, {}, resolve));
  return { send, local: ctx.chrome.storage.local.data, calls, listeners };
}

const lookup = { type: "lookup", name: "AK-47 | Redline (Field-Tested)", buff: { currency: "USD", cents: 2000 },
  href: "https://buff.market/market/goods/cs2/AK-47%20%7C%20Redline%20(Field-Tested)",
  page: { level: "supported", label: "All Items" } };

test("service worker loads and registers its listeners", () => {
  const w = makeWorker({ current: {} });
  assert.ok(w.listeners.message && w.listeners.connect && w.listeners.action && w.listeners.tabRemoved);
});

test("profitable lookup is saved; turning unprofitable removes it", async () => {
  const steam = { current: { success: true, lowest_price: "$31.93", volume: "71", median_price: "$33.09" } };
  const w = makeWorker(steam);
  const r1 = await w.send(lookup);
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.saved, true);
  const key = "r:" + lookup.name;
  assert.ok(w.local[key] && w.local[key].gain > 0);
  assert.ok(w.calls.some((u) => u.includes("priceoverview") && u.includes("currency=1")));
  assert.ok(!w.calls.some((u) => /127\.0\.0\.1|localhost/.test(u))); // no local-app traffic

  // Same item, now priced so it loses money (cache bypass: new worker instance with same storage is not needed;
  // a different BUFF price on the cached Steam data is enough to turn it unprofitable)
  const r2 = await w.send({ ...lookup, buff: { currency: "USD", cents: 4000 } });
  assert.equal(r2.saved, false);
  assert.equal(r2.removed, true);
  assert.ok(!(key in w.local));
});

test("item with no Steam listing is neither saved nor an error", async () => {
  const w = makeWorker({ current: { success: true } });
  const r = await w.send(lookup);
  assert.equal(r.ok, true);
  assert.equal(r.steam.status, "not_found");
  assert.equal(r.saved, false);
  assert.deepEqual(Object.keys(w.local), []);
});
