// Live (opt-in): Recent Buy Orders hover is blocked (no lookup, nothing saved); All Items still works (1 Steam lookup).
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const ext = path.resolve(fileURLToPath(import.meta.url), "../..");
const ctx = await chromium.launchPersistentContext("", { headless: true, channel: "chromium", viewport: { width: 1400, height: 950 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
const steamRequests = [];
// Count Steam lookups made by the extension's service worker
await sw.evaluate(() => {
  const orig = self.fetch;
  self.__steamCalls = 0;
  self.fetch = (u, o) => { if (String(u).includes("steamcommunity.com")) self.__steamCalls++; return orig(u, o); };
});
const popup = (p) => p.evaluate(() => {
  const h = document.getElementById("bmx-host");
  return h && h.style.display === "block" ? h.shadowRoot.getElementById("p").innerText : "";
});
const records = () => sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("r:")));

const p = await ctx.newPage();
await p.goto("https://buff.market/market/buy_order", { waitUntil: "networkidle", timeout: 60000 });
await p.keyboard.press("Escape");
const card = p.locator('a[href*="/market/goods/cs2/"]').first();
await card.hover({ force: true });
await p.waitForFunction(() => document.getElementById("bmx-host")?.style.display === "block", null, { timeout: 15000 });
await p.waitForTimeout(1500);
const t1 = await popup(p);
console.log("BUY ORDERS popup:\n" + t1);
assert.match(t1, /Not supported here \(Recent Buy Orders\)/);
assert.equal(await sw.evaluate(() => self.__steamCalls), 0);
assert.deepEqual(await records(), []);

await p.goto("https://buff.market/market/all", { waitUntil: "networkidle", timeout: 60000 });
const c2 = p.locator('a[href*="/market/goods/cs2/"]').first();
const name = decodeURIComponent((await c2.getAttribute("href")).split("?")[0].split("/").pop());
await c2.hover({ force: true });
await p.waitForFunction((n) => {
  const h = document.getElementById("bmx-host");
  const t = h?.shadowRoot?.getElementById("p")?.innerText ?? "";
  return h.style.display === "block" && t.startsWith(n) && /Wallet-value gain/.test(t) && !/⚠/.test(t);
}, name, { timeout: 30000 });
const t2 = await popup(p);
console.log("\nALL ITEMS popup (tail):\n" + t2.split("\n").slice(-4).join("\n"));
assert.equal(await sw.evaluate(() => self.__steamCalls), 1);
assert.equal((await records()).length, 1);
await ctx.close();
console.log("\nE2E PAGES: PASS");
