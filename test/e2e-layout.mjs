// Live (opt-in): popup sits over the neighbouring card (next card's left edge, or previous card's right edge
// for the last card in a row); spinner rotates even with prefers-reduced-motion. 2 Steam requests.
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const ext = path.resolve(fileURLToPath(import.meta.url), "../..");
const out = process.argv[2] || ".";
const ctx = await chromium.launchPersistentContext("", { headless: true, channel: "chromium", viewport: { width: 1400, height: 950 },
  reducedMotion: "reduce", args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const p = await ctx.newPage();
await p.goto("https://buff.market/market/all", { waitUntil: "networkidle", timeout: 60000 });
await p.keyboard.press("Escape");

const cards = p.locator('a[href*="/market/goods/cs2/"]');
// Spinner animation under reduced motion
const anim = await p.evaluate(() => {
  const root = document.getElementById("bmx-host").shadowRoot;
  const sp = document.createElement("span"); sp.className = "sp"; root.getElementById("p").append(sp);
  const name = getComputedStyle(sp).animationName; sp.remove(); return name;
});
console.log("spinner animation with prefers-reduced-motion:", anim);
assert.equal(anim, "spin");

// Cards of the first row
const row = await p.$$eval('a[href*="/market/goods/cs2/"]', (as) => {
  const boxes = as.map((a, i) => ({ i, r: (a.firstElementChild || a).getBoundingClientRect() }));
  const top = boxes[0].r.top;
  return boxes.filter((b) => Math.abs(b.r.top - top) < 4).map((b) => ({ i: b.i, left: b.r.left, right: b.r.right, top: b.r.top }));
});
console.log("first row cards:", row.length);
// Visible popup for THIS card with a finished lookup
const done = (name) => {
  const h = document.getElementById("bmx-host");
  const t = h?.shadowRoot?.getElementById("p")?.innerText ?? "";
  return h?.style.display === "block" && t.startsWith(name) && /Wallet-value gain|failed|no listing/.test(t);
};
const nameOf = async (i) => decodeURIComponent((await cards.nth(i).getAttribute("href")).split("?")[0].split("/").pop());
const popupBox = () => p.evaluate(() => { const r = document.getElementById("bmx-host").shadowRoot.getElementById("p").getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; });

await cards.nth(row[0].i).hover();
await p.waitForFunction(done, await nameOf(row[0].i), { timeout: 30000 });
await p.waitForTimeout(200);
let b = await popupBox();
console.log(`first card: popup left ${b.left.toFixed(0)} vs next card left ${row[1].left.toFixed(0)}; top ${b.top.toFixed(0)} vs ${row[0].top.toFixed(0)}`);
assert.ok(Math.abs(b.left - row[1].left) <= 1.5);
await p.screenshot({ path: `${out}/layout-first.png` });

await p.mouse.move(5, 5);
const last = row[row.length - 1], prev = row[row.length - 2];
await cards.nth(last.i).hover();
await p.waitForFunction(done, await nameOf(last.i), { timeout: 30000 });
await p.waitForTimeout(200);
b = await popupBox();
console.log(`last card: popup right ${b.right.toFixed(0)} vs previous card right ${prev.right.toFixed(0)}`);
assert.ok(Math.abs(b.right - prev.right) <= 1.5);
await p.screenshot({ path: `${out}/layout-last.png` });
await ctx.close();
console.log("E2E LAYOUT: PASS");
