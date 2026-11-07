// Live (opt-in): hover 3 real buff.market cards -> Results page ranking + deletion. ~3 Steam requests.
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const ext = path.resolve(fileURLToPath(import.meta.url), "../..");
const out = process.argv[2] || ".";
const ctx = await chromium.launchPersistentContext("", { headless: true, channel: "chromium", viewport: { width: 1500, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;

const p = await ctx.newPage();
await p.goto("https://buff.market/market/all", { waitUntil: "networkidle", timeout: 60000 });
const cards = p.locator('a[href*="/market/goods/cs2/"]');
const saved = [], notSaved = [];
for (let i = 0; i < 8 && saved.length < 3; i++) {
  const c = cards.nth(i);
  const name = decodeURIComponent((await c.getAttribute("href")).split("?")[0].split("/").pop());
  await c.scrollIntoViewIfNeeded();
  await c.hover();
  await p.waitForFunction((n) => {
    const h = document.getElementById("bmx-host");
    const t = h?.shadowRoot?.getElementById("p")?.innerText ?? "";
    return h?.style.display === "block" && t.startsWith(n) && /Saved ·|Not saved|failed|no listing|Not supported/i.test(t);
  }, name, { timeout: 40000 });
  const t = await p.evaluate(() => document.getElementById("bmx-host").shadowRoot.getElementById("p").innerText);
  (/Saved ·/.test(t) ? saved : notSaved).push(name);
  await p.mouse.move(5, 5);
  await p.waitForTimeout(300);
}
console.log("saved (profitable):", saved, "\nnot saved:", notSaved);
assert.ok(saved.length >= 2, "need at least 2 profitable items on the first 8 cards to test deletion");

const r = await ctx.newPage();
r.on("dialog", (d) => d.accept());
await r.goto(`chrome-extension://${extId}/results.html`);
await r.waitForSelector("#rows tr");
const rowNames = async () => r.$$eval("#rows tr td.name > span:first-child", (ss) => ss.map((x) => x.textContent));
const headers = await r.$$eval("thead th", (ths) => ths.map((t) => t.textContent.trim()).filter(Boolean));
console.log("headers:", headers);
assert.deepEqual(headers, ["Item", "Links", "BUFF cost", "Steam ask", "24h sales / median", "Sell at → credit", "Profit", "Steam fetched"]);
const rows = await r.$$eval("#rows tr", (trs) => trs.map((tr) => ({
  item: tr.querySelector("td.name").innerText.split("\n")[0],
  links: [...tr.querySelectorAll("td.links a")].map((a) => `${a.textContent}=${new URL(a.href).hostname}`),
  linksText: tr.querySelector("td.links").textContent,
  profit: tr.children[7].textContent, fetched: tr.children[8].textContent })));
console.log("rows:", JSON.stringify(rows, null, 1));
assert.deepEqual((await rowNames()).sort(), [...saved].sort()); // unprofitable items were not stored
for (const row of rows) {
  assert.doesNotMatch(row.item, /BUFF|Steam/);
  assert.equal(row.linksText, "BUFF – Steam");
  assert.deepEqual(row.links, ["BUFF=buff.market", "Steam=steamcommunity.com"]);
  assert.match(row.profit, /^\+\d+\.\d{2}% \(\+\d+[.,]\d{2}(\$| €|£)\)$/);
}
const pcts = rows.map((x) => parseFloat(x.profit));
assert.deepEqual(pcts, [...pcts].sort((a, b) => b - a)); // default sort: profit %, descending
await r.screenshot({ path: `${out}/ext-results.png` });

await r.click("th[data-sort=cost]");
console.log("sorted by cost:", await rowNames());

// single delete
const first = (await rowNames())[0];
await r.click("#rows tr:first-child button.x");
await r.waitForFunction((n) => ![...document.querySelectorAll("#rows td.name a")].some((a) => a.textContent === n), first);
assert.equal((await rowNames()).length, saved.length - 1);
console.log("deleted one:", first);

// select one + delete selected
await r.check("#rows tr:first-child input[type=checkbox]");
assert.equal(await r.textContent("#delSel"), "Delete selected (1)");
await r.click("#delSel");
await r.waitForFunction((n) => document.querySelectorAll("#rows tr").length === n, saved.length - 2);
console.log("deleted selected -> remaining:", await rowNames());

// delete everything
await r.click("#delAll");
await r.waitForFunction(() => document.querySelectorAll("#rows tr").length === 0);
const left = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("r:")).length);
assert.equal(left, 0);
console.log("delete everything -> storage records left:", left, "| empty message shown:", await r.isVisible("#empty"));
await ctx.close();
console.log("E2E RESULTS: PASS");
