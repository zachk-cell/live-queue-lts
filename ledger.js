// Durable sales ledger + back-office store.
//
// The queue itself only keeps the current board and the last few streams. This
// module keeps EVERYTHING, forever, on the persistent disk:
//   data/sales-ledger.json  — every order ever seen (live or offline, any status)
//                             plus every stream (start/end + break summaries).
//   data/backoffice.json    — per-item cost / consignment terms, fee settings,
//                             the edit changelog, the synced catalog and stock
//                             snapshots, and the back-office password hash.
// Reports, profitability, exports and the sales-metrics dashboard all read from
// here. Writes are debounced and atomic (write tmp + rename) so a crash mid-write
// can never corrupt the file.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'sales-ledger.json');
const BO_FILE = path.join(DATA_DIR, 'backoffice.json');

export const DEFAULT_SETTINGS = {
  tiktokFeePct: 6,          // TikTok Shop fee, % of the sale
  streamerPct: 10,          // streamer commission, % of the sale
  shippingMode: 'fixed',    // 'fixed' = $ per order, 'pct' = % of the order
  shippingFixed: 8,         // estimated $ per order
  shippingPct: 5,           // estimated % of the order
  timezone: 'America/New_York',
};

export function itemKey(it) {
  if (it && it.skuId) return 'sku:' + String(it.skuId);
  if (it && it.productId) return 'prod:' + String(it.productId);
  return 'name:' + normName(it && it.name);
}
export function normName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export class Ledger {
  constructor() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    this.orders = {};   // id -> order record
    this.streams = {};  // id -> { id, startedAt, endedAt, breaks, seeded }
    this.meta = {};     // { seedVersion }
    this.bo = {
      settings: { ...DEFAULT_SETTINGS },
      items: {},        // itemKey -> { cost, consigned, consignee, splitType:'pct'|'fixed', splitValue, notes }
      changelog: [],    // newest first
      catalog: { products: [], syncedAt: null, error: '' },
      snapshots: [],    // [{ ts, stock: { skuId: qty }, price: { skuId: price } }] (daily)
      password: null,   // { salt, hash } (scrypt) — only when not set via env
      lastImport: null,
    };
    this._timer = null;
    this._boTimer = null;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(LEDGER_FILE)) {
        const j = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
        this.orders = j.orders || {};
        this.streams = j.streams || {};
        this.meta = j.meta || {};
      }
    } catch (e) { console.warn('[ledger] load failed:', e.message); }
    try {
      if (fs.existsSync(BO_FILE)) {
        const j = JSON.parse(fs.readFileSync(BO_FILE, 'utf8'));
        this.bo = { ...this.bo, ...j, settings: { ...DEFAULT_SETTINGS, ...(j.settings || {}) } };
      }
    } catch (e) { console.warn('[ledger] backoffice load failed:', e.message); }
    console.log(`[ledger] ${Object.keys(this.orders).length} orders, ${Object.keys(this.streams).length} streams on file`);
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
    this._timer.unref?.();
  }
  flush() {
    clearTimeout(this._timer);
    try { atomicWrite(LEDGER_FILE, JSON.stringify({ v: 1, meta: this.meta || {}, orders: this.orders, streams: this.streams })); }
    catch (e) { console.warn('[ledger] persist failed:', e.message); }
  }
  saveBo() {
    clearTimeout(this._boTimer);
    this._boTimer = setTimeout(() => this.flushBo(), 300);
    this._boTimer.unref?.();
  }
  flushBo() {
    clearTimeout(this._boTimer);
    try { atomicWrite(BO_FILE, JSON.stringify(this.bo)); }
    catch (e) { console.warn('[ledger] backoffice persist failed:', e.message); }
  }

  // ---------------- item terms ----------------
  /** Current terms for an item: SKU entry, then product entry, then name entry. */
  termsFor(it) {
    const keys = [];
    if (it.skuId) keys.push('sku:' + it.skuId);
    if (it.productId) keys.push('prod:' + it.productId);
    keys.push('name:' + normName(it.name));
    const out = {};
    // Product-level fills gaps the SKU entry leaves; SKU wins where set.
    for (const k of keys.slice().reverse()) {
      const t = this.bo.items[k];
      if (!t) continue;
      for (const [f, v] of Object.entries(t)) if (v !== undefined && v !== null && v !== '') out[f] = v;
    }
    return out;
  }

  // ---------------- orders ----------------
  /** Record (or refresh) an order. ctx = { channel:'live'|'offline', streamId, source }. */
  recordOrder(raw, ctx = {}) {
    if (!raw || raw.id == null || raw.test) return null; // test orders never count as sales
    const id = String(raw.id);
    const prev = this.orders[id];
    const items = (raw.items || []).map((it) => {
      const line = {
        name: String(it.name || 'Item'),
        productId: it.productId ? String(it.productId) : '',
        skuId: it.skuId ? String(it.skuId) : '',
        sku: it.sku ? String(it.sku) : '',
        qty: Number(it.qty) || 1,
        price: Number(it.price) || 0,
        cancelled: !!it.cancelled,
      };
      // Stamp consignment terms at the moment of sale so later edits to an
      // item's terms never rewrite what a past sale paid out.
      const t = this.termsFor(line);
      if (t.consigned) line.cs = { consignee: t.consignee || '', splitType: t.splitType || 'pct', splitValue: Number(t.splitValue) || 0 };
      return line;
    });
    if (prev) {
      // Keep the original channel/stream; refresh money + cancellation fields.
      if (items.length && (!prev.items.length || prev.source === 'history')) prev.items = items;
      for (const it of prev.items) {
        const m = items.find((x) => x.name === it.name && (x.skuId || '') === (it.skuId || ''));
        if (m) it.cancelled = m.cancelled;
      }
      if (raw.total != null && Number(raw.total)) prev.total = Number(raw.total);
      if (raw.shippingFee != null) prev.shippingFee = Number(raw.shippingFee) || 0;
      if (raw.cancelRequested && !prev.cancelRequested) prev.cancelRequested = true;
      this.save();
      return prev;
    }
    const rec = {
      id,
      createdAt: Number(raw.createdAt) || Date.now(),
      buyerId: String(raw.buyerId || ''),
      buyer: String(raw.buyer || 'Buyer'),
      buyerHandle: String(raw.buyerHandle || ''),
      items,
      total: Number(raw.total) || items.reduce((s, it) => s + it.price * it.qty, 0),
      shippingFee: Number(raw.shippingFee) || 0,
      channel: ctx.channel === 'offline' ? 'offline' : 'live',
      streamId: ctx.streamId ? String(ctx.streamId) : null,
      source: ctx.source || 'ingest',
      status: 'placed',
      recordedAt: Date.now(),
    };
    this.orders[id] = rec;
    this.save();
    return rec;
  }
  markCancelled(orderId, at = Date.now()) {
    const o = this.orders[String(orderId)];
    if (!o || o.status === 'cancelled') return false;
    o.status = 'cancelled'; o.cancelledAt = at;
    this.save();
    return true;
  }
  markFulfilled(orderId, at = Date.now()) {
    const o = this.orders[String(orderId)];
    if (!o || o.fulfilledAt) return false;
    o.fulfilledAt = at;
    this.save();
    return true;
  }
  unmarkFulfilled(orderId) {
    const o = this.orders[String(orderId)];
    if (!o || !o.fulfilledAt) return false;
    o.fulfilledAt = null;
    this.save();
    return true;
  }

  // ---------------- streams ----------------
  startStream(id, startedAt) {
    const k = String(id);
    this.streams[k] = { ...(this.streams[k] || {}), id: k, startedAt: startedAt || Number(id) || Date.now(), endedAt: null };
    this.save();
  }
  endStream(id, endedAt, extra = {}) {
    const k = String(id);
    const s = this.streams[k] || { id: k, startedAt: Number(id) || null };
    this.streams[k] = { ...s, ...extra, endedAt: endedAt || Date.now() };
    this.save();
  }
  streamList() {
    return Object.values(this.streams).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }
  ordersForStream(id) {
    const k = String(id);
    return Object.values(this.orders).filter((o) => o.streamId === k);
  }
  /** Which stream (if any) was running at time t — used to classify imports. */
  streamAt(t) {
    for (const s of Object.values(this.streams)) {
      if (s.startedAt && t >= s.startedAt && t <= (s.endedAt || Date.now())) return s;
    }
    return null;
  }

  /** One-time seed from the queue's short history (last few streams) so past
   *  reports exist from day one. Never overwrites orders already on file.
   *  An order can appear in several archived streams (open breaks carry over),
   *  so each order is credited to the stream it was PLACED in: the stream whose
   *  window contains its order time, otherwise the earliest stream it appears in. */
  seedFromHistory(history) {
    const hist = (history || []).filter((h) => h && (h.id || h.startedAt))
      .slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)); // oldest first
    for (const h of hist) {
      const sid = String(h.id || h.startedAt);
      if (!this.streams[sid]) this.streams[sid] = { id: sid, startedAt: h.startedAt || Number(sid) || null, endedAt: h.endedAt || null, breaks: h.breaks || [], seeded: true };
    }
    const windows = hist.map((h) => ({ sid: String(h.id || h.startedAt), a: h.startedAt || 0, b: h.endedAt || Date.now() }));
    const homeFor = (t, fallback) => { if (t) { const w = windows.find((x) => t >= x.a && t <= x.b); if (w) return w.sid; } return fallback; };
    const pick = new Map(); // orderId -> { r, kind, sid, startedAt }
    for (const h of hist) {
      const sid = String(h.id || h.startedAt);
      for (const [kind, recs] of [['fulfilled', h.fulfilled], ['unfulfilled', h.unfulfilled], ['cancelled', h.cancelled]]) {
        for (const r of (recs || [])) {
          if (!r || r.orderId == null) continue;
          const id = String(r.orderId);
          const prev = pick.get(id);
          // Keep the first (earliest) sighting for placement, but the LATEST
          // status (a spot unfulfilled in one stream may be fulfilled in the next).
          if (!prev) pick.set(id, { r, kind, sid, startedAt: h.startedAt, createdAt: r.createdAt || null });
          else { prev.kind = kind; prev.r = { ...prev.r, ...r, items: (r.items && r.items.length >= (prev.r.items || []).length) ? r.items : prev.r.items }; if (!prev.createdAt && r.createdAt) prev.createdAt = r.createdAt; }
        }
      }
    }
    let added = 0;
    for (const [id, p] of pick) {
      if (this.orders[id]) continue;
      const r = p.r;
      const items = (r.items || []).map((it) => ({
        name: String(it.name || 'Item'), productId: '', skuId: '', sku: it.sku || '',
        qty: Number(it.qty) || 1, price: Number(it.price) || 0, cancelled: !!it.cancelled,
      }));
      this.orders[id] = {
        id, createdAt: p.createdAt || p.startedAt || r.fulfilledAt || r.cancelledAt || Date.now(),
        approxTime: !p.createdAt,
        buyerId: String(r.buyerId || ''), buyer: String(r.buyer || 'Buyer'), buyerHandle: '',
        items, total: Number(r.total) || 0, shippingFee: 0,
        channel: 'live', streamId: homeFor(p.createdAt, p.sid), source: 'history',
        status: p.kind === 'cancelled' ? 'cancelled' : 'placed',
        cancelledAt: r.cancelledAt || null, fulfilledAt: r.fulfilledAt || null,
        recordedAt: Date.now(),
      };
      added++;
    }
    this.meta = { ...(this.meta || {}), seedVersion: 2 };
    if (added) { this.save(); console.log(`[ledger] seeded ${added} orders from stream history`); }
    return added;
  }

  /** v1 of the history seed credited carried-over break orders to the LATEST
   *  stream they were archived in. Re-seed those once (nothing else is touched:
   *  live/offline/imported orders and any later updates on them are kept). */
  repairHistorySeed(history) {
    if (this.meta && this.meta.seedVersion >= 2) return 0;
    const ids = Object.keys(this.orders).filter((id) => this.orders[id].source === 'history');
    const keep = {}; // preserve status changes made since the first seed
    for (const id of ids) { const o = this.orders[id]; keep[id] = { status: o.status, cancelledAt: o.cancelledAt, fulfilledAt: o.fulfilledAt }; delete this.orders[id]; }
    const n = this.seedFromHistory(history);
    for (const [id, k] of Object.entries(keep)) {
      const o = this.orders[id]; if (!o) continue;
      if (k.status === 'cancelled') { o.status = 'cancelled'; o.cancelledAt = o.cancelledAt || k.cancelledAt; }
      if (k.fulfilledAt && !o.fulfilledAt) o.fulfilledAt = k.fulfilledAt;
    }
    this.flush();
    console.log(`[ledger] history re-seeded (${ids.length} → ${n} orders, credited to the stream they were placed in)`);
    return n;
  }

  // ---------------- back office ----------------
  log(entry) {
    this.bo.changelog.unshift({ ts: Date.now(), ...entry });
    if (this.bo.changelog.length > 5000) this.bo.changelog.length = 5000;
    this.saveBo();
  }
  setItemTerms(key, patch, meta = {}) {
    const k = String(key);
    const cur = this.bo.items[k] || {};
    const next = { ...cur };
    const changes = [];
    for (const f of ['cost', 'consigned', 'consignee', 'splitType', 'splitValue', 'notes']) {
      if (!(f in patch)) continue;
      let v = patch[f];
      if (f === 'cost' || f === 'splitValue') v = (v === '' || v == null) ? null : Math.round(Number(v) * 100) / 100;
      if (f === 'consigned') v = !!v;
      if (f === 'splitType') v = v === 'fixed' ? 'fixed' : 'pct';
      if (typeof v === 'number' && !isFinite(v)) continue;
      if (JSON.stringify(cur[f] ?? null) === JSON.stringify(v ?? null)) continue;
      changes.push({ field: f, from: cur[f] ?? null, to: v });
      next[f] = v;
    }
    if (!changes.length) return { changed: 0 };
    this.bo.items[k] = next;
    for (const c of changes) this.log({ kind: 'terms', key: k, label: meta.label || k, ...c });
    this.saveBo();
    return { changed: changes.length };
  }
  setSettings(patch) {
    const s = this.bo.settings;
    const changes = [];
    for (const f of ['tiktokFeePct', 'streamerPct', 'shippingMode', 'shippingFixed', 'shippingPct', 'timezone']) {
      if (!(f in patch)) continue;
      let v = patch[f];
      if (f === 'shippingMode') v = v === 'pct' ? 'pct' : 'fixed';
      else if (f === 'timezone') { v = String(v || DEFAULT_SETTINGS.timezone); try { new Intl.DateTimeFormat('en-US', { timeZone: v }); } catch { continue; } }
      else { v = Number(v); if (!isFinite(v) || v < 0) continue; v = Math.round(v * 100) / 100; }
      if (s[f] === v) continue;
      changes.push({ field: f, from: s[f], to: v });
      s[f] = v;
    }
    for (const c of changes) this.log({ kind: 'setting', key: 'settings', label: 'Settings', ...c });
    this.saveBo();
    return { changed: changes.length };
  }

  // Password: env BACKOFFICE_PASSWORD wins; otherwise a scrypt hash on disk.
  passwordSource() {
    if (process.env.BACKOFFICE_PASSWORD) return 'env';
    return this.bo.password ? 'disk' : 'unset';
  }
  checkPassword(pw) {
    const p = String(pw || '');
    if (process.env.BACKOFFICE_PASSWORD) {
      const a = Buffer.from(crypto.createHash('sha256').update(p).digest('hex'));
      const b = Buffer.from(crypto.createHash('sha256').update(process.env.BACKOFFICE_PASSWORD).digest('hex'));
      return crypto.timingSafeEqual(a, b);
    }
    const st = this.bo.password;
    if (!st) return false;
    const h = crypto.scryptSync(p, Buffer.from(st.salt, 'hex'), 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(st.hash));
  }
  setPassword(pw) {
    const p = String(pw || '');
    if (p.length < 8) return false;
    const salt = crypto.randomBytes(16);
    this.bo.password = { salt: salt.toString('hex'), hash: crypto.scryptSync(p, salt, 32).toString('hex') };
    this.log({ kind: 'security', key: 'password', label: 'Back office password', field: 'password', from: null, to: 'changed' });
    this.flushBo();
    return true;
  }

  // Catalog (TikTok Product API — needs the product scope).
  setCatalog(products, error = '') {
    if (Array.isArray(products)) {
      this.bo.catalog = { products, syncedAt: Date.now(), error: '' };
      // One stock/price snapshot per day (for time-to-sell + sell-through).
      const day = new Date().toISOString().slice(0, 10);
      const last = this.bo.snapshots[this.bo.snapshots.length - 1];
      const snap = { ts: Date.now(), day, stock: {}, price: {} };
      for (const p of products) for (const s of (p.skus || [])) { snap.stock[s.id] = s.stock; snap.price[s.id] = s.price; }
      if (last && last.day === day) this.bo.snapshots[this.bo.snapshots.length - 1] = snap;
      else this.bo.snapshots.push(snap);
      if (this.bo.snapshots.length > 1200) this.bo.snapshots.splice(0, this.bo.snapshots.length - 1200);
    } else {
      this.bo.catalog = { ...this.bo.catalog, error: String(error || 'sync failed'), errorAt: Date.now() };
    }
    this.saveBo();
  }
}
