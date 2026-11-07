/* Service worker: the only place that talks to Steam / ECB. Content scripts cannot (CORS), and no
   cookies are ever sent (credentials: "omit"), so your Steam login is never involved. */
importScripts("core.js");
const { parsePriceOverview, STEAM_CURRENCY_ID, DEFAULT_SETTINGS, steamListingUrl, buildRecord, RESULT_PREFIX,
  MAX_RESULTS, isProfitable } = self.BMX;

const STEAM_PRICE = "https://steamcommunity.com/market/priceoverview/";
const ECB_DAILY = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

async function settings() {
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...s };
}

// ---------------------------------------------------------------- cache (memory + session storage)
const mem = new Map();
const inflight = new Map();

async function cacheGet(key, ttlMs) {
  let hit = mem.get(key);
  if (!hit) {
    hit = (await chrome.storage.session.get(key))[key];
    if (hit) mem.set(key, hit);
  }
  return hit && Date.now() - hit.fetchedAt < ttlMs ? hit : null;
}
async function cachePut(key, value) {
  mem.set(key, value);
  await chrome.storage.session.set({ [key]: value });
}

// ---------------------------------------------------------------- rate limiting
let nextSlot = 0; // earliest time the next Steam request may start
let cooldownUntil = 0; // set after HTTP 429; no requests until then

async function takeSlot(maxPerMinute, onProgress) {
  const now = Date.now();
  if (now < cooldownUntil) {
    throw Object.assign(new Error("Steam rate limit hit — paused"), { cooldownUntil });
  }
  const gap = 60000 / Math.max(1, maxPerMinute);
  const start = Math.max(now, nextSlot);
  if (start - now > 20000) throw new Error("Too many lookups queued — slow down hovering");
  nextSlot = start + gap;
  if (start > now) {
    onProgress("queued", { startsAt: start });
    await new Promise((r) => setTimeout(r, start - now));
  }
}

async function steamLookup(name, onProgress = () => {}) {
  const s = await settings();
  const ccy = s.walletCurrency;
  const key = `steam:${ccy}:${name}`;
  const cached = await cacheGet(key, s.cacheMinutes * 60000);
  if (cached) return { ...cached, cached: true };
  if (inflight.has(key)) {
    onProgress("fetching", {});
    return inflight.get(key);
  }
  const p = (async () => {
    await takeSlot(s.maxPerMinute, onProgress);
    onProgress("fetching", {});
    const url = `${STEAM_PRICE}?appid=730&currency=${STEAM_CURRENCY_ID[ccy]}&market_hash_name=${encodeURIComponent(name)}`;
    const res = await fetch(url, { credentials: "omit", cache: "no-store" });
    if (res.status === 429) {
      cooldownUntil = Date.now() + 5 * 60000;
      throw Object.assign(new Error("Steam rate limit (HTTP 429) — pausing lookups for 5 minutes"), { cooldownUntil });
    }
    if (!res.ok) throw new Error(`Steam HTTP ${res.status}`);
    const parsed = parsePriceOverview(await res.json(), ccy);
    if (parsed.status === "error") throw new Error(parsed.error);
    const value = { ...parsed, fetchedAt: Date.now(), source: "steamcommunity.com priceoverview (24h summary)" };
    await cachePut(key, value);
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------- ECB FX (cached 12h)
async function fxRates() {
  const cached = await cacheGet("fx:ecb", 12 * 3600000);
  if (cached) return cached;
  const res = await fetch(ECB_DAILY, { credentials: "omit" });
  if (!res.ok) throw new Error(`ECB HTTP ${res.status}`);
  const xml = await res.text();
  const rates = {};
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g)) rates[m[1]] = Number(m[2]);
  const day = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
  if (!rates.USD) throw new Error("ECB feed missing USD");
  const value = { rates, effectiveDate: day, fetchedAt: Date.now(), source: "European Central Bank reference rates" };
  await cachePut("fx:ecb", value);
  return value;
}

// ---------------------------------------------------------------- saved results (chrome.storage.local, one key per item)
let savesSinceCheck = 0;

async function saveResult(name, href, buff, steam, fx, s, page) {
  const key = RESULT_PREFIX + name;
  const previous = (await chrome.storage.local.get(key))[key];
  const rec = buildRecord({ name, href, buff, steam, fx, settings: s, now: Date.now(), previous, page });
  if (!isProfitable(rec)) {
    // Only positive returns are stored; an item that stopped being profitable is removed.
    if (previous) await chrome.storage.local.remove(key);
    return { saved: false, removed: Boolean(previous) };
  }
  await chrome.storage.local.set({ [key]: rec });
  if (++savesSinceCheck >= 50) {
    savesSinceCheck = 0;
    const all = Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith(RESULT_PREFIX));
    if (all.length > MAX_RESULTS) {
      all.sort((a, b) => a[1].buffSeenAt - b[1].buffSeenAt); // drop the oldest beyond the cap
      await chrome.storage.local.remove(all.slice(0, all.length - MAX_RESULTS).map(([k]) => k));
    }
  }
  return { saved: true, removed: false };
}

async function openResults() {
  const url = chrome.runtime.getURL("results.html");
  const [existing] = await chrome.tabs.query({ url });
  if (existing) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url });
}
chrome.action.onClicked.addListener(openResults);

// ---------------------------------------------------------------- messages
const pendingVerify = new Map(); // tabId -> { name, buff, href }

async function doLookup(msg, onProgress = () => {}) {
  const s = await settings();
  const [steam, fx] = await Promise.all([steamLookup(msg.name, onProgress),
    fxRates().catch((e) => ({ error: String(e.message || e) }))]);
  let saved = false, removed = false;
  if (s.saveResults && steam.status === "ok" && fx.rates) {
    ({ saved, removed } = await saveResult(msg.name, msg.href, msg.buff, steam, fx, s, msg.page));
  }
  return { ok: true, steam, fx, settings: s, saved, removed };
}

// Port-based lookup: streams progress ("queued" with a start time, "fetching") before the result.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "lookup") return;
  let open = true;
  port.onDisconnect.addListener(() => { open = false; });
  const post = (m) => { if (open) { try { port.postMessage(m); } catch { open = false; } } };
  port.onMessage.addListener((msg) => {
    doLookup(msg, (stage, data) => post({ type: "progress", stage, ...data }))
      .then((res) => post({ type: "result", res }),
        (e) => post({ type: "result", res: { ok: false, error: String(e.message || e), cooldownUntil: e.cooldownUntil } }));
  });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === "lookup") {
      return doLookup(msg);
    }
    if (msg.type === "openVerify") {
      const tab = await chrome.tabs.create({ url: steamListingUrl(msg.name), index: (sender.tab?.index ?? 0) + 1 });
      const vctx = { name: msg.name, buff: msg.buff, href: msg.href, api: msg.api ?? null };
      pendingVerify.set(tab.id, vctx);
      await chrome.storage.session.set({ [`verify:${tab.id}`]: vctx });
      return { ok: true };
    }
    if (msg.type === "verifyContext") {
      const id = sender.tab?.id;
      const ctx = pendingVerify.get(id) ?? (await chrome.storage.session.get(`verify:${id}`))[`verify:${id}`];
      if (!ctx) return { ok: false };
      const [s, fx] = await Promise.all([settings(), fxRates().catch(() => null)]);
      return { ok: true, ...ctx, settings: s, fx };
    }
    if (msg.type === "openResults") {
      await openResults();
      return { ok: true };
    }
    if (msg.type === "openOptions") {
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    }
    return { ok: false, error: "unknown message" };
  })().then(reply, (e) => reply({ ok: false, error: String(e.message || e), cooldownUntil: e.cooldownUntil }));
  return true;
});

chrome.tabs.onRemoved.addListener((id) => {
  pendingVerify.delete(id);
  chrome.storage.session.remove(`verify:${id}`);
});
