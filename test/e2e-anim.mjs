// Live (opt-in): fade in/out timing, loader states (fetching, queued countdown), no loader flash on cache hits.
// 2 Steam requests (rate limit temporarily set to 4/min so the 2nd lookup is queued).
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const ext = path.resolve(fileURLToPath(import.meta.url), "../..");
const out = process.argv[2] || ".";
const ctx = await chromium.launchPersistentContext("", { headless: true, channel: "chromium", viewport: { width: 1400, height: 950 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
await sw.evaluate(() => chrome.storage.sync.set({ maxPerMinute: 4 }));

const p = await ctx.newPage();
await p.goto("https://buff.market/market/all", { waitUntil: "networkidle", timeout: 60000 });
const cards = p.locator('a[href*="/market/goods/cs2/"]');

// Record popup opacity + loader visibility every animation frame for `ms`.
const sample = (ms) => p.evaluate((ms) => new Promise((resolve) => {
  const h = document.getElementById("bmx-host");
  const panel = h.shadowRoot.getElementById("p");
  const t0 = performance.now(), frames = [];
  const step = () => {
    const ld = panel.querySelector(".ld");
    frames.push({ t: Math.round(performance.now() - t0), display: h.style.display,
      opacity: Number(getComputedStyle(panel).opacity).toFixed(2),
      loader: ld ? Number(getComputedStyle(ld).opacity).toFixed(2) : null, text: ld?.textContent ?? null });
    if (performance.now() - t0 < ms) requestAnimationFrame(step); else resolve(frames);
  };
  step();
}), ms);
const wait = (cond, arg, timeout = 30000) => p.waitForFunction(cond, arg, { timeout });
const shown = () => document.getElementById("bmx-host")?.style.display === "block";

// 1) Fade in + fetching loader
await cards.nth(0).hover();
await wait(shown);
const fadeIn = await sample(220);
const firstFull = fadeIn.find((f) => f.opacity === "1.00");
console.log("fade-in: first frame", fadeIn[0], "| fully opaque at", firstFull?.t, "ms");
const ldShown = fadeIn.find((f) => f.loader === "1.00");
console.log("fetching loader fully visible at", ldShown?.t ?? "(result arrived first)", "ms");
assert.ok(Number(fadeIn[0].opacity) < 1 && firstFull && firstFull.t <= 180, "fade-in should complete in ~120ms");
await wait(() => {
  const t = document.getElementById("bmx-host").shadowRoot.getElementById("p").innerText;
  return /Fetching Steam price|Wallet credit|failed/.test(t);
});
await p.screenshot({ path: `${out}/anim-1-fetching.png`, clip: { x: 0, y: 100, width: 1400, height: 500 } }).catch(() => {});
await wait(() => /Wallet credit|failed|no listing/.test(document.getElementById("bmx-host").shadowRoot.getElementById("p").innerText));
console.log("card 0 result loaded");

// 2) Queued: next lookup must wait for a slot -> countdown text
await p.mouse.move(5, 5);
await cards.nth(1).hover();
await wait(() => /Waiting for a Steam lookup slot \(rate limit\) · \d+s/.test(document.getElementById("bmx-host")?.shadowRoot?.getElementById("p")?.innerText ?? ""));
const q1 = await p.evaluate(() => document.getElementById("bmx-host").shadowRoot.querySelector(".ld").textContent);
await p.waitForTimeout(1300);
const q2 = await p.evaluate(() => document.getElementById("bmx-host").shadowRoot.querySelector(".ld")?.textContent);
const qOpacity = await p.evaluate(() => getComputedStyle(document.getElementById("bmx-host").shadowRoot.querySelector(".ld")).opacity);
console.log("queued countdown:", JSON.stringify(q1), "->", JSON.stringify(q2), "| loader opacity:", qOpacity);
assert.equal(qOpacity, "1", "loader must be visible while queued");
assert.notEqual(q1, q2, "countdown should tick");
const hostBox = await p.evaluate(() => { const r = document.getElementById("bmx-host").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await p.screenshot({ path: `${out}/anim-2-queued.png`, clip: { x: Math.max(0, hostBox.x - 10), y: Math.max(0, hostBox.y - 10), width: 340, height: Math.min(300, hostBox.h + 20) } });
await wait(() => /Wallet credit|failed|no listing/.test(document.getElementById("bmx-host").shadowRoot.getElementById("p").innerText), null, 40000);
console.log("card 1 result loaded after queue");

// 3) Fade out
await p.mouse.move(5, 5);
await p.waitForTimeout(150); // mouseout grace period before hiding starts
const fadeOut = await sample(200);
const gone = fadeOut.find((f) => f.display === "none");
console.log("fade-out: first", fadeOut[0], "| display:none at", gone?.t, "ms");
assert.ok(gone && gone.t <= 160, "fade-out should finish in ~100ms");

// 4) Cached re-hover: no loader flash
await cards.nth(0).hover();
await wait(shown);
const cached = await sample(300);
const loaderVisible = cached.some((f) => f.loader !== null && Number(f.loader) > 0);
console.log("cached re-hover: loader ever visible?", loaderVisible);
assert.equal(loaderVisible, false);
await sw.evaluate(() => chrome.storage.sync.set({ maxPerMinute: 12 }));
await ctx.close();
console.log("E2E ANIM: PASS");
