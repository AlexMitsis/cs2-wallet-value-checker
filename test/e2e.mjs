// Live smoke test (opt-in): real buff.market page + real Steam lookups, a handful of requests.
// Usage: node test/e2e.mjs <screenshot-dir>   (first: npm install && npm run e2e:install)
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "@playwright/test";

const ext = path.resolve(fileURLToPath(import.meta.url), "../..");
const out = process.argv[2] || ".";
const ctx = await chromium.launchPersistentContext("", {
  headless: true, channel: "chromium", viewport: { width: 1400, height: 950 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const popupText = (p) => p.evaluate(() => document.getElementById("bmx-host")?.shadowRoot?.getElementById("p")?.innerText ?? "");
const p = await ctx.newPage();
await p.goto("https://buff.market/market/all", { waitUntil: "networkidle", timeout: 60000 });
await p.waitForTimeout(1500);
const cards = p.locator('a[href*="/market/goods/cs2/"]');
console.log("cards on page:", await cards.count());
for (let i = 0; i < 3; i++) {
  const c = cards.nth(i);
  const name = decodeURIComponent((await c.getAttribute("href")).split("/").pop());
  await c.scrollIntoViewIfNeeded();
  await c.hover();
  // wait until the popup is visible, shows THIS card's name, and the lookup has finished
  await p.waitForFunction((n) => {
    const host = document.getElementById("bmx-host");
    const t = host?.shadowRoot?.getElementById("p")?.innerText ?? "";
    return host.style.display === "block" && t.startsWith(n) && !t.includes("Fetching Steam price") && !t.includes("Waiting for a Steam lookup slot");
  }, name, { timeout: 30000 });
  const t = await popupText(p);
  console.log(`\n=== card ${i} ===\n${t}`);
  await p.screenshot({ path: `${out}/ext-hover-${i}.png` });
  await p.mouse.move(5, 5);
  await p.waitForTimeout(400);
}
// Verify flow from the first card that produced a result
await cards.nth(0).hover();
await p.waitForTimeout(1500);
const [steamTab] = await Promise.all([
  ctx.waitForEvent("page", { timeout: 30000 }),
  p.evaluate(() => document.getElementById("bmx-host").shadowRoot.querySelector("button")?.click()),
]);
await steamTab.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
await steamTab.waitForTimeout(3000);
const verify = await steamTab.evaluate(() => document.getElementById("bmx-verify")?.shadowRoot?.getElementById("p")?.innerText ?? "(no overlay)");
console.log("\n=== verify tab ===\nURL:", steamTab.url(), "\n" + verify);
await steamTab.evaluate(() => {
  const i = document.getElementById("bmx-verify").shadowRoot.querySelector("input");
  i.value = "99.99"; i.dispatchEvent(new Event("input"));
});
await steamTab.waitForTimeout(300);
console.log("\n=== after typing 99.99 ===\n" + await steamTab.evaluate(() => document.getElementById("bmx-verify").shadowRoot.getElementById("p").innerText));
await steamTab.screenshot({ path: `${out}/ext-verify.png` });
await ctx.close();
