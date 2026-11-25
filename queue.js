// Core queue engine.
//
// Behaviour (per seller's rules):
//  - Orders are grouped into one SLOT per buyer while that buyer still has an
//    unfulfilled slot. A buyer who orders again before being fulfilled is
//    merged into their existing slot (items + total combined), NOT re-queued.
//    Once a slot is fulfilled, a later order from that buyer opens a fresh slot.
//  - PRIORITY is item-driven: if a slot contains any configured "priority item",
//    it is STAGGERED up the queue rather than stacked. Priority never overtakes
//    whoever is currently at the top; below that, priority and regular slots
//    alternate by time received (priority, regular, priority, regular …), so
//    regular buyers keep moving up. Slots only sit back-to-back when there's
//    nothing of the other kind to stagger against.
//  - A slot can also be manually bumped to the very top.
//  - "Mark fulfilled" closes a slot (the whole buyer batch).
//  - State persists to disk so a crash/restart mid-live never loses the queue.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'queue-state.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const MAX_HISTORY = 5; // keep the last N streams for the admin history view

/**
 * Order record:
 * {
 *   id, buyerId, buyer,
 *   items: [{ name, qty }], total, createdAt,
 *   status: 'queued'|'fulfilled',
 *   batchKey,            // slot this order belongs to
 *   hasPriority          // does this order contain a priority item
 * }
 */

export class QueueEngine extends EventEmitter {
  constructor() {
    super();
    this.orders = new Map(); // orderId -> order
    this.openBatch = new Map(); // buyerId -> current open batchKey (or absent)
    this.batchCounter = 0;
    this.priorityItems = []; // array of lowercased substrings that trigger priority
    this.trackedVariants = []; // [{ id, label, product, variant }] — per-variant sales counters
    this.variantCounts = {}; // { [variantId]: number } — units counted when a slot hits the top
    this.variantLog = []; // audit trail of manual counter edits/resets (most recent first)
    this.live = false; // when false, incoming orders are ignored (not queued)
    this.sessionStartedAt = null; // when the current live started
    this.history = []; // archived past streams (most recent first)
    // Stream clip log (editor aid): a manually-set stream start time and a running
    // list of clip marks. Independent of the queue — purely a timestamp tool so
    // moments worth clipping can be flagged with one click for the video editor.
    this.streamStartAt = null; // ms epoch of the stream start (auto-set at Go Live; manually editable)
    this.streamEndAt = null;   // ms epoch the stream went offline — freezes the running timer
    this.clips = [];           // [{ id, at (ms epoch), note }]
    this.clipCounter = 0;
    // BREAKS (event-style, like iPoke quacks): items that belong to a break are
    // pulled OUT of the running queue into their own break list, so a 40-spot
    // break doesn't clog the live queue. Any non-break items in the same order
    // still go to the queue as normal, and both sides are flagged.
    //   breaks: [{ id, title, match, status:'open'|'ripped', auto, createdAt, rippedAt }]
    this.breaks = [];
    this.breakCounter = 0;
    this.breakKeywords = ['break']; // item text containing one of these auto-opens a break
    this.autoBreaks = true;         // auto-create a break per break product
    this.breakIgnore = [];          // product phrases that must NEVER be treated as a break
    this._ensureDataDir();
    this._load();
    this._seedFromEnv();
  }

  _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  _load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        this.priorityItems = (cfg.priorityItems || []).map((s) => s.toLowerCase());
        this.trackedVariants = Array.isArray(cfg.trackedVariants) ? cfg.trackedVariants : [];
        this.variantCounts = (cfg.variantCounts && typeof cfg.variantCounts === 'object') ? cfg.variantCounts : {};
        this.variantLog = Array.isArray(cfg.variantLog) ? cfg.variantLog : [];
        this.batchCounter = cfg.batchCounter || 0;
        this.live = !!cfg.live;
        this.sessionStartedAt = cfg.sessionStartedAt || null;
        this.streamStartAt = cfg.streamStartAt || null;
        this.streamEndAt = cfg.streamEndAt || null;
        this.clips = Array.isArray(cfg.clips) ? cfg.clips : [];
        this.clipCounter = cfg.clipCounter || 0;
        this.breaks = Array.isArray(cfg.breaks) ? cfg.breaks : [];
        this.breakCounter = cfg.breakCounter || 0;
        if (Array.isArray(cfg.breakKeywords)) this.breakKeywords = cfg.breakKeywords.map((x) => String(x).toLowerCase()).filter(Boolean);
        if (cfg.autoBreaks === false) this.autoBreaks = false;
        this.breakIgnore = Array.isArray(cfg.breakIgnore) ? cfg.breakIgnore : [];
      }
    } catch (e) {
      console.warn('[queue] could not load config:', e.message);
    }
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        this.history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || [];
      }
    } catch (e) {
      console.warn('[queue] could not load history:', e.message);
    }
    try {
      if (fs.existsSync(STATE_FILE)) {
        const arr = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        for (const o of arr) this.orders.set(o.id, o);
        // Rebuild openBatch map from queued orders.
        for (const o of arr) {
          if (o.status === 'queued') this.openBatch.set(o.buyerId, o.batchKey);
        }
        console.log(`[queue] restored ${this.orders.size} orders from disk`);
      }
    } catch (e) {
      console.warn('[queue] could not load state:', e.message);
    }
  }

  /**
   * Per-store configuration lives in env vars so BOTH stores can run the exact
   * same code. Idempotent and safe to run every boot:
   *  - PRIORITY_ITEMS_EXTRA: comma/newline list of item substrings that should
   *    ALWAYS trigger priority (unioned in, never removes existing).
   *  - TRACKED_VARIANTS: JSON array of { id, label, product, variant } — the
   *    per-variant counters. Only the DEFINITIONS are seeded; live counts in
   *    variantCounts are never touched here.
   */
  _seedFromEnv() {
    try {
      const extra = String(process.env.PRIORITY_ITEMS_EXTRA || '')
        .split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (extra.length) {
        const set = new Set(this.priorityItems);
        for (const p of extra) set.add(p);
        this.priorityItems = [...set];
      }
    } catch (e) { console.warn('[queue] PRIORITY_ITEMS_EXTRA seed failed:', e.message); }
    try {
      if (process.env.TRACKED_VARIANTS) {
        const defs = JSON.parse(process.env.TRACKED_VARIANTS);
        if (Array.isArray(defs)) {
          const byId = new Map(this.trackedVariants.map((v) => [v.id, v]));
          for (const d of defs) {
            if (!d || d.id == null) continue;
            byId.set(String(d.id), {
              id: String(d.id),
              label: String(d.label || d.id),
              product: String(d.product || ''),
              variant: String(d.variant || ''),
            });
          }
          this.trackedVariants = [...byId.values()];
        }
      }
    } catch (e) { console.warn('[queue] TRACKED_VARIANTS seed failed:', e.message); }
    // Recompute priority flags in case the env extras changed matching, then save.
    for (const o of this.orders.values()) o.hasPriority = this._isPriorityOrder(o.items);
    this._persist();
  }

  /** Stamp the current top slot's orders with reachedTopAt (once each) and tally
   *  any tracked-variant units they contain. Called after every queue mutation
   *  so "reached the top" is detected no matter what caused the reorder. */
  _markTopReached() {
    const top = this.activeQueue()[0];
    if (!top) return false;
    const orders = [...this.orders.values()].filter(
      (o) => o.batchKey === top.key && o.status === 'queued' && !o.reachedTopAt
    );
    if (!orders.length) return false;
    const now = Date.now();
    for (const o of orders) {
      o.reachedTopAt = now;
      this._tallyVariants(o);
    }
    return true;
  }

  /** Add an order's units to any matching tracked-variant counters. Matches on
   *  the item name/SKU text: requires the variant substring, and (if set) the
   *  product substring too, so a short variant token can't match unrelated items. */
  _tallyVariants(order) {
    if (!this.trackedVariants.length) return;
    for (const it of (order.items || [])) {
      const text = `${it.name || ''} ${it.sku || ''}`.toLowerCase();
      const qty = it.qty || 1;
      for (const v of this.trackedVariants) {
        const prod = (v.product || '').toLowerCase();
        const varn = (v.variant || '').toLowerCase();
        if (!varn) continue;
        if ((!prod || text.includes(prod)) && text.includes(varn)) {
          this.variantCounts[v.id] = (this.variantCounts[v.id] || 0) + qty;
        }
      }
    }
  }

  /** Replace the tracked-variant DEFINITIONS (admin editor). Preserves the live
   *  count for any id that still exists; drops counts for removed ids. */
  setTrackedVariants(list) {
    const defs = (Array.isArray(list) ? list : []).filter((d) => d && d.id != null).map((d) => ({
      id: String(d.id),
      label: String(d.label || d.id),
      product: String(d.product || ''),
      variant: String(d.variant || ''),
    }));
    this.trackedVariants = defs;
    const keep = {};
    for (const d of defs) keep[d.id] = this.variantCounts[d.id] || 0;
    this.variantCounts = keep;
    this._persist();
    this.emit('change', { reason: 'variants-config' });
  }

  /** Manually set one variant's counter (admin correction) or reset it to 0.
   *  Every manual change is written to variantLog with the BEFORE value, so if a
   *  counter is ever changed/reset by mistake the prior number is recoverable. */
  setVariantCount(id, n) {
    const key = String(id);
    const v = this.trackedVariants.find((x) => x.id === key);
    if (!v) return false;
    const from = this.variantCounts[key] || 0;
    const to = Math.max(0, Math.floor(Number(n) || 0));
    this.variantCounts[key] = to;
    this._logVariant({
      id: key, label: v.label, from, to,
      action: (to === 0 && from !== 0) ? 'reset' : 'edit',
    });
    this._persist();
    this.emit('change', { reason: 'variant-count', id: key });
    return true;
  }

  /** Append an audit entry (most-recent-first) and cap the log size. */
  _logVariant(entry) {
    this.variantLog.unshift({ ts: Date.now(), ...entry });
    if (this.variantLog.length > 200) this.variantLog.length = 200;
  }

  _persist() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify([...this.orders.values()]));
      fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify({
          priorityItems: this.priorityItems,
          trackedVariants: this.trackedVariants,
          variantCounts: this.variantCounts,
          variantLog: this.variantLog,
          batchCounter: this.batchCounter,
          live: this.live,
          sessionStartedAt: this.sessionStartedAt,
          streamStartAt: this.streamStartAt,
          streamEndAt: this.streamEndAt,
          clips: this.clips,
          clipCounter: this.clipCounter,
          breaks: this.breaks,
          breakCounter: this.breakCounter,
          breakKeywords: this.breakKeywords,
          autoBreaks: this.autoBreaks,
          breakIgnore: this.breakIgnore,
        })
      );
    } catch (e) {
      console.warn('[queue] persist failed:', e.message);
    }
  }

  _persistHistory() {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.history));
    } catch (e) {
      console.warn('[queue] history persist failed:', e.message);
    }
  }

  /** Detailed per-order records of everything fulfilled this session. */
  fulfilledRecords() {
    const doneIds = this._doneBreakOrderIds();
    return [...this.orders.values()]
      .filter((o) => o.status === 'fulfilled' || (o.status === 'break' && doneIds.has(o.id)))
      .sort((a, b) => (b.fulfilledAt || 0) - (a.fulfilledAt || 0))
      .map((o) => ({
        orderId: o.id,
        buyerId: o.buyerId,
        buyer: o.buyer,
        items: this._allItems(o),
        total: this._fullTotal(o),
        fulfilledAt: o.fulfilledAt || Math.max(0, ...Object.values(o.breakDone || {}),
          ...Object.values(o.breakDoneRounds || {}).flatMap((m) => Object.values(m))) || null,
      }));
  }

  /** Every line of an order (queue items + any items that went to a break) —
   *  used for exports/history so nothing that went to a break is lost. */
  _allItems(o) {
    return [...(o.items || []), ...(o.breakItems || []).map((it) => ({ ...it, break: this._breakTitle(it.breakId) })),
      ...(o.offlineItems || []).map((it) => ({ ...it, offline: true }))];
  }
  _fullTotal(o) { return o.fullTotal != null ? o.fullTotal : o.total; }

  /** Order ids of everything still queued — used by the poller to batch-refresh
   *  On Hold status. */
  queuedOrderIds() {
    // Break-only orders are still live, unshipped orders — keep them in the
    // hold/cancel re-check too.
    return [...this.orders.values()].filter((o) => o.status === 'queued' || o.status === 'break').map((o) => o.id);
  }

  /** Flag/unflag a queued order as On Hold (TikTok-side). Returns true if it
   *  actually changed, so the poller can log only real transitions. */
  setHold(orderId, onHold) {
    const o = this.orders.get(String(orderId));
    if (!o || (o.status !== 'queued' && o.status !== 'break')) return false;
    if (!!o.onHold === !!onHold) return false;
    o.onHold = !!onHold;
    this._persist();
    this.emit('change', { reason: 'hold-change', orderId: String(orderId), onHold: !!onHold });
    return true;
  }

  /** Refresh cancellation info for a queued order — order-level flag plus the
   *  per-item cancelled flags. upsertOrder is idempotent on order id, so a
   *  cancellation that lands AFTER the order is already queued (the common case
   *  during a live) has to be applied here rather than on re-ingest. Returns true
   *  if anything actually changed, so the poller can log only real transitions.
   *  info = { cancelRequested:boolean, items:[{name, cancelled}] }. */
  setCancelInfo(orderId, info) {
    const o = this.orders.get(String(orderId));
    if (!o || (o.status !== 'queued' && o.status !== 'break')) return false;
    let changed = false;
    const nextReq = !!(info && info.cancelRequested);
    if (!!o.cancelRequested !== nextReq) { o.cancelRequested = nextReq; changed = true; }
    // Merge per-item cancelled flags by item name (the display name already folds
    // in the variant, so it uniquely identifies the line to the packer).
    if (info && Array.isArray(info.items) && info.items.length) {
      const cancelledNames = new Set(info.items.filter((it) => it.cancelled).map((it) => it.name));
      for (const it of [...(o.items || []), ...(o.breakItems || [])]) {
        const nc = cancelledNames.has(it.name);
        if (!!it.cancelled !== nc) { it.cancelled = nc; changed = true; }
      }
    }
    if (changed) {
      this._persist();
      this.emit('change', { reason: 'cancel-change', orderId: String(orderId), cancelRequested: nextReq });
    }
    return changed;
  }

  /** Detailed per-order records of orders still queued (unfulfilled) this
   *  session — captured when a stream is archived so nothing is silently lost. */
  queuedRecords() {
    const doneIds = this._doneBreakOrderIds();
    return [...this.orders.values()]
      .filter((o) => o.status === 'queued' || (o.status === 'break' && !doneIds.has(o.id)))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map((o) => ({
        orderId: o.id,
        buyerId: o.buyerId,
        buyer: o.buyer,
        items: this._allItems(o),
        total: this._fullTotal(o),
        createdAt: o.createdAt,
      }));
  }

  /** Detailed per-order records of everything cancelled this session. */
  cancelledRecords() {
    return [...this.orders.values()]
      .filter((o) => o.status === 'cancelled')
      .sort((a, b) => (b.cancelledAt || 0) - (a.cancelledAt || 0))
      .map((o) => ({
        orderId: o.id,
        buyerId: o.buyerId,
        buyer: o.buyer,
        items: this._allItems(o),
        total: this._fullTotal(o),
        cancelledAt: o.cancelledAt,
      }));
  }

  _isPriorityOrder(items) {
    if (!this.priorityItems.length) return false;
    return (items || []).some((it) => {
      const name = (it.name || '').toLowerCase();
      const sku = (it.sku || '').toLowerCase();
      return this.priorityItems.some((p) => p && (name.includes(p) || sku.includes(p)));
    });
  }

  /** Ingest an order. Merges into the buyer's open slot if one exists. */
  upsertOrder(raw) {
    const id = String(raw.id);
    if (this.orders.has(id)) return this.orders.get(id); // idempotent on order id

    // Off-air: when not live, incoming orders are ignored — EXCEPT spots for a
    // break that's still open, which go straight into that break. Any regular
    // items in the same order are kept on the entry for reference (not queued).
    if (!this.live) {
      const bi = []; const other = [];
      for (const it of (raw.items || [])) {
        const br = this._breakFor(it, false);
        if (br) bi.push({ ...it, breakId: br.id }); else other.push(it);
      }
      if (!bi.length) return null;
      const priced = bi.reduce((s, it) => s + (Number(it.price) || 0) * (it.qty || 1), 0);
      const order = {
        id, buyerId: String(raw.buyerId), buyer: raw.buyer || 'Buyer', buyerHandle: raw.buyerHandle || '',
        items: [], breakItems: bi, offlineItems: other,
        total: priced || Number(raw.total || 0), fullTotal: Number(raw.total || 0),
        createdAt: raw.createdAt || Date.now(), receivedAt: Date.now(),
        status: 'break', batchKey: `brk:${id}`, breakOnly: true, hasPriority: false, offline: true,
        onHold: !!raw.onHold, cancelRequested: !!raw.cancelRequested,
      };
      this.orders.set(id, order);
      this._persist();
      this.emit('change', { reason: 'break-entry-offline', order });
      return order;
    }

    const buyerId = String(raw.buyerId);
    const createdAt0 = raw.createdAt || Date.now();
    // Split the order: break items go to their break, everything else queues.
    const items = [];
    const breakItems = [];
    for (const it of (raw.items || [])) {
      const br = this._breakFor(it, true);
      if (br) breakItems.push({ ...it, breakId: br.id });
      else items.push(it);
    }
    if (breakItems.length && !items.length) {
      // Break-only order: never enters the running queue.
      const order = {
        id, buyerId,
        buyer: raw.buyer || 'Buyer',
        buyerHandle: raw.buyerHandle || '',
        items: [], breakItems,
        total: Number(raw.total || 0), fullTotal: Number(raw.total || 0),
        createdAt: createdAt0, receivedAt: Date.now(),
        status: 'break', batchKey: `brk:${id}`, breakOnly: true,
        hasPriority: false,
        onHold: !!raw.onHold, cancelRequested: !!raw.cancelRequested,
      };
      this.orders.set(id, order);
      this._persist();
      this.emit('change', { reason: 'break-entry', order });
      return order;
    }
    const hasPriority = this._isPriorityOrder(items);

    // Find (or open) the buyer's active slot.
    let batchKey = this.openBatch.get(buyerId);
    let mergedInto = false;
    if (batchKey) {
      mergedInto = true;
    } else {
      batchKey = `${buyerId}#${++this.batchCounter}`;
      this.openBatch.set(buyerId, batchKey);
    }

    // Was this buyer already sitting at the TOP of the queue (position 1, i.e.
    // very likely already being packed) when this new order merged in? Flag it
    // so the packer is loudly told to add the new item(s) to the bag in
    // progress instead of assuming that slot is done. (Computed before the new
    // order is added; a merge never changes the slot's position.)
    let mergedWhileTop = false;
    if (mergedInto) {
      const top = this.activeQueue()[0];
      mergedWhileTop = !!(top && top.key === batchKey);
    }

    const order = {
      id,
      buyerId,
      buyer: raw.buyer || 'Buyer',
      buyerHandle: raw.buyerHandle || '',
      items,
      breakItems,
      total: breakItems.length ? this._splitTotal(raw, items) : Number(raw.total || 0),
      fullTotal: Number(raw.total || 0),
      createdAt: createdAt0,
      receivedAt: Date.now(),
      status: 'queued',
      batchKey,
      hasPriority,
      mergedWhileTop,
      onHold: !!raw.onHold,
      // Genuine cancellation (order-level or a specific item) — distinct from the
      // broad onHold flag, and what actually drives the CANCEL REQ badge.
      cancelRequested: !!raw.cancelRequested,
    };
    this.orders.set(id, order);
    this._markTopReached();
    this._persist();

    const entry = this._entryFor(batchKey);
    this.emit('change', { reason: mergedInto ? 'merged' : 'new-slot', entry, order });
    if (!mergedInto) this.emit('new-slot', entry);
    else this.emit('merged', { entry, order });
    return order;
  }

  /** Build an aggregated slot entry from all queued orders sharing a batchKey. */
  _entryFor(batchKey) {
    const orders = [...this.orders.values()].filter(
      (o) => o.batchKey === batchKey && o.status === 'queued'
    );
    if (!orders.length) return null;
    const first = orders.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
    // How many orders from this same buyer were already fulfilled earlier this
    // stream — powers the "ordered earlier today" heads-up badge in the panel.
    const priorFulfilled = [...this.orders.values()].filter(
      (o) => o.buyerId === first.buyerId && o.status === 'fulfilled'
    ).length;
    const priorityOrders = orders.filter((o) => o.hasPriority);
    const isPriority = priorityOrders.length > 0;
    const priorityAt = isPriority
      ? Math.min(...priorityOrders.map((o) => o.createdAt))
      : Infinity;

    // Merge item lines (sum quantities of same-name items).
    const itemMap = new Map();
    for (const o of orders) {
      for (const it of o.items) {
        const key = it.name;
        const prev = itemMap.get(key) || { qty: 0, cancelled: false };
        prev.qty += (it.qty || 1);
        if (it.cancelled) prev.cancelled = true;
        itemMap.set(key, prev);
      }
    }
    const items = [...itemMap.entries()].map(([name, v]) => ({ name, qty: v.qty, cancelled: v.cancelled }));

    const reachedAts = orders.map((o) => o.reachedTopAt).filter(Boolean);
    // Break items from these same orders (they went to a break, NOT this bag).
    const bn = new Map();
    for (const o of orders) {
      for (const it of (o.breakItems || [])) {
        const k = it.breakId + '|' + it.name;
        const prev = bn.get(k) || { breakId: it.breakId, title: this._breakTitle(it.breakId), name: it.name, qty: 0, orderId: o.id };
        prev.qty += (it.qty || 1);
        bn.set(k, prev);
      }
    }
    return {
      key: batchKey,
      breakNotes: [...bn.values()],
      buyerId: first.buyerId,
      buyer: first.buyer,
      // Admin-only cross-check: the buyer's unique @username (the queue label is
      // their display name). Never surfaced on the public view.
      buyerHandle: first.buyerHandle || '',
      orderIds: orders.map((o) => o.id),
      orderCount: orders.length,
      // Per-order breakdown (oldest first) so the panel can group the expanded
      // view by order number and separate anything added after the buyer hit #1.
      // Same-name items WITHIN an order are summed (5× pack, not 1× pack ×5).
      orderLines: orders
        .slice()
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .map((o) => {
          const m = new Map();
          for (const it of (o.items || [])) {
            const prev = m.get(it.name) || { qty: 0, cancelled: false };
            prev.qty += (it.qty || 1);
            if (it.cancelled) prev.cancelled = true;
            m.set(it.name, prev);
          }
          return {
            id: o.id,
            items: [...m.entries()].map(([name, v]) => ({ name, qty: v.qty, cancelled: v.cancelled })),
            addedSinceTop: !!o.mergedWhileTop,
          };
        }),
      items,
      itemCount: items.reduce((n, i) => n + i.qty, 0),
      total: orders.reduce((s, o) => s + o.total, 0),
      isPriority,
      priorityItems: [...new Set(
        orders.flatMap((o) => o.items.filter((it) => this._isPriorityOrder([it])).map((it) => it.name))
      )],
      firstOrderAt: first.createdAt,
      // When this slot first reached the top of the queue (drives the "time at
      // top" live timer and the fulfillment-time metric). null until it hits #1.
      reachedTopAt: reachedAts.length ? Math.min(...reachedAts) : null,
      priorityAt,
      bumped: !!first.bumped,
      priorFulfilled,
      // True when a new order merged into this slot while it was already #1 in
      // the queue — surfaced as a loud "ADDED MORE" badge in the panel. The
      // count is how many times it happened, so the badge can show ×2/×3 if the
      // buyer keeps adding after you've already started combining.
      reorderedAtTop: orders.some((o) => o.mergedWhileTop),
      reorderedAtTopCount: orders.filter((o) => o.mergedWhileTop).length,
      // TikTok put one of this slot's orders On Hold — could be an address check,
      // an order combine/split, a sample/exchange order, or a pending review. On
      // its own it is NOT a cancellation; surfaced as a soft "verify" badge.
      onHold: orders.some((o) => o.onHold),
      // A genuine cancellation was requested on one of this slot's orders (whole
      // order or a specific item). This drives the red CANCEL REQ badge and the
      // per-item highlight; the specific item(s) are marked in items/orderLines.
      cancelRequested: orders.some((o) => o.cancelRequested),
      _bumpKey: batchKey,
    };
  }

  markFulfilled(batchKey) {
    const orders = [...this.orders.values()].filter(
      (o) => o.batchKey === batchKey && o.status === 'queued'
    );
    if (!orders.length) return null;
    const buyerId = orders[0].buyerId;
    const now = Date.now();
    for (const o of orders) {
      o.status = 'fulfilled';
      o.fulfilledAt = now;
      o.bumped = false;
    }
    if (this.openBatch.get(buyerId) === batchKey) this.openBatch.delete(buyerId);
    this._markTopReached();
    this._persist();
    this.emit('change', { reason: 'fulfilled', batchKey, buyerId });
    return { batchKey, buyerId };
  }

  reopen(batchKey) {
    const orders = [...this.orders.values()].filter((o) => o.batchKey === batchKey);
    if (!orders.length) return null;
    if (orders.every((o) => o.breakOnly)) {
      // A cancelled break entry being restored goes back into its break.
      for (const o of orders) { o.status = 'break'; o.cancelledAt = null; }
      this._persist();
      this.emit('change', { reason: 'reopened', batchKey });
      return { batchKey };
    }
    const buyerId = orders[0].buyerId;
    // Only reopen if the buyer has no other open slot.
    if (this.openBatch.has(buyerId)) return null;
    for (const o of orders) {
      o.status = 'queued';
      o.fulfilledAt = null;
    }
    this.openBatch.set(buyerId, batchKey);
    this._markTopReached();
    this._persist();
    this.emit('change', { reason: 'reopened', batchKey });
    return { batchKey };
  }

  /** Force a slot to the very top. Only one slot can be bumped at a time. */
  bump(batchKey) {
    let found = false;
    for (const o of this.orders.values()) {
      if (o.batchKey === batchKey && o.status === 'queued') {
        o.bumped = true;
        found = true;
      } else if (o.bumped) {
        o.bumped = false;
      }
    }
    if (!found) return null;
    this._markTopReached();
    this._persist();
    this.emit('change', { reason: 'bumped', batchKey });
    return { batchKey };
  }

  /** Configure which item names/SKUs trigger priority. Recomputes existing orders. */
  setPriorityItems(list) {
    this.priorityItems = (list || [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean);
    for (const o of this.orders.values()) {
      o.hasPriority = this._isPriorityOrder(o.items);
    }
    this._markTopReached();
    this._persist();
    this.emit('change', { reason: 'priority-config', priorityItems: this.priorityItems });
  }

  /** Archive the current stream (fulfilled + cancelled + still-unfulfilled) to
   *  history, if it had any activity. Does NOT clear the board — callers do. */
  _archiveCurrentStream() {
    const records = this.fulfilledRecords();
    const cancelledRecs = this.cancelledRecords();
    const unfulfilledRecs = this.queuedRecords();
    if (records.length || cancelledRecs.length || unfulfilledRecs.length || this.breaks.length) {
      this.history.unshift({
        id: String(this.sessionStartedAt || Date.now()),
        startedAt: this.sessionStartedAt || null,
        endedAt: Date.now(),
        count: records.length,
        value: records.reduce((s, r) => s + r.total, 0),
        unfulfilledCount: unfulfilledRecs.length,
        fulfilled: records,
        cancelled: cancelledRecs,
        unfulfilled: unfulfilledRecs,
        breaks: this.breakSummaries().map((b) => ({
          id: b.id, title: b.title, status: b.status, spots: b.spots, value: b.value,
          entries: b.entries.map((e) => ({ orderId: e.orderId, buyer: e.buyer, qty: e.qty, items: e.items, cancelled: e.cancelled, done: e.done, round: e.round })),
        })),
      });
      this.history = this.history.slice(0, MAX_HISTORY);
      this._persistHistory();
    }
  }

  /** Start a live: archives anything left from a stream that wasn't ended,
   *  clears the queue, and begins accepting orders. */
  /** Open breaks that still have spots to rip survive the end of a stream:
   *  the break plus every order in it (fulfilled spots too, so round/spot
   *  numbering carries on). Mixed orders keep only their break part — the
   *  queue clears as before. Closed or fully-fulfilled breaks are dropped. */
  _carryOverBreaks() {
    const keepIds = new Set(this.breakSummaries()
      .filter((b) => b.status === 'open' && b.activeSpots > 0).map((b) => b.id));
    const orders = [];
    for (const o of this.orders.values()) {
      if (o.status === 'cancelled') continue;
      const bi = (o.breakItems || []).filter((it) => keepIds.has(it.breakId));
      if (!bi.length) continue;
      const full = o.fullTotal != null ? o.fullTotal : o.total;
      const priced = bi.reduce((s, it) => s + (Number(it.price) || 0) * (it.qty || 1), 0);
      orders.push({
        ...o, items: [], breakItems: bi.map((it) => ({ ...it })),
        status: 'break', breakOnly: true, batchKey: `brk:${o.id}`, bumped: false,
        total: priced || full, fullTotal: priced || full, carriedOver: true,
      });
    }
    return { breaks: this.breaks.filter((b) => keepIds.has(b.id)), orders };
  }

  /** Clear the board after archiving, keeping carried-over breaks. */
  _clearBoardKeepingBreaks() {
    const keep = this._carryOverBreaks();
    this.orders.clear();
    this.openBatch.clear();
    this.breaks = keep.breaks;
    for (const o of keep.orders) this.orders.set(o.id, o);
    return keep;
  }

  goLive() {
    // Safety net: archive a stream that was never ended. (If it WAS ended,
    // it's already archived — what's left is only carried-over breaks.)
    if (this.live) this._archiveCurrentStream();
    this._clearBoardKeepingBreaks();
    // Per-variant counters PERSIST across streams (cumulative running totals).
    // They are only ever changed by the auto-tally or a manual admin edit/reset.
    this.sessionStartedAt = Date.now();
    this.live = true;
    // Auto-start the clip timer at go-live and begin a fresh clip log for this
    // stream. The operator can still adjust the start time manually afterward.
    this.streamStartAt = Date.now();
    this.streamEndAt = null;
    this.clips = [];
    this._persist();
    this.emit('change', { reason: 'go-live' });
  }

  /** End a live: archive the whole stream (fulfilled, cancelled, and any
   *  still-unfulfilled orders) to Past streams, then clear the board so the
   *  main page empties and everything moves to history. Stops new orders. */
  endLive() {
    this._archiveCurrentStream();
    // The queue clears; open breaks with spots left to rip stay put.
    this._clearBoardKeepingBreaks();
    this.live = false;
    // Freeze the clip timer at the moment the stream went offline. The start time
    // (and clips) are kept so the clip list stays copyable for the editor.
    if (this.streamStartAt) this.streamEndAt = Date.now();
    this._persist();
    this.emit('change', { reason: 'end-live' });
  }

  /**
   * Active queue, top = next to handle. Priority is STAGGERED, not stacked:
   *   1. Manually bumped slots pin to the very top (explicit operator override).
   *   2. The slot currently AT the top is never overtaken — a newly-arriving
   *      priority can't knock whoever is being handled off #1. The current top is
   *      the still-queued slot that reached the top earliest (locked once reached);
   *      before anything has reached the top, the earliest-arrived slot holds #1.
   *   3. Everything below is staggered by time received: priority, regular,
   *      priority, regular … (priority tier by priority-item purchase time, regular
   *      tier by first order time). When one tier runs out the other just continues,
   *      so slots only sit back-to-back when there's nothing to stagger against.
   */
  activeQueue() {
    const keys = new Set(
      [...this.orders.values()].filter((o) => o.status === 'queued').map((o) => o.batchKey)
    );
    const entries = [...keys].map((k) => this._entryFor(k)).filter(Boolean);

    // 1. Manually bumped slots -> very top.
    const bumped = entries.filter((e) => e.bumped)
      .sort((a, b) => a.firstOrderAt - b.firstOrderAt);
    let rest = entries.filter((e) => !e.bumped);

    // 2. Protect whoever is currently at the top.
    let anchor = null;
    const reached = rest.filter((e) => e.reachedTopAt != null);
    if (reached.length) {
      anchor = reached.reduce((a, b) => (a.reachedTopAt <= b.reachedTopAt ? a : b));
    } else if (rest.length) {
      anchor = rest.reduce((a, b) => (a.firstOrderAt <= b.firstOrderAt ? a : b));
    }
    if (anchor) rest = rest.filter((e) => e !== anchor);

    // 3. Stagger the remainder: priority, regular, priority, regular …
    const pri = rest.filter((e) => e.isPriority)
      .sort((a, b) => a.priorityAt - b.priorityAt);
    const reg = rest.filter((e) => !e.isPriority)
      .sort((a, b) => a.firstOrderAt - b.firstOrderAt);
    const staggered = [];
    let i = 0, j = 0;
    while (i < pri.length || j < reg.length) {
      if (i < pri.length) staggered.push(pri[i++]);
      if (j < reg.length) staggered.push(reg[j++]);
    }

    const ordered = [...bumped, ...(anchor ? [anchor] : []), ...staggered];
    // Break spots this buyer holds on OTHER orders (bought separately) — so the
    // packer sees the buyer is also in a break even though it's not this order.
    const byBuyer = new Map();
    for (const o of this.orders.values()) {
      if (o.status === 'cancelled' || !(o.breakItems || []).length) continue;
      for (const it of o.breakItems) {
        if (it.cancelled) continue;
        if (!byBuyer.has(o.buyerId)) byBuyer.set(o.buyerId, []);
        byBuyer.get(o.buyerId).push({ orderId: o.id, breakId: it.breakId, name: it.name, qty: it.qty || 1 });
      }
    }
    for (const e of ordered) {
      const mine = new Set(e.orderIds);
      const m = new Map();
      for (const x of (byBuyer.get(e.buyerId) || [])) {
        if (mine.has(x.orderId)) continue;
        const prev = m.get(x.breakId) || { breakId: x.breakId, title: this._breakTitle(x.breakId), qty: 0, orderIds: [] };
        prev.qty += x.qty;
        if (!prev.orderIds.includes(x.orderId)) prev.orderIds.push(x.orderId);
        m.set(x.breakId, prev);
      }
      e.otherBreaks = [...m.values()];
    }
    return ordered.map((e, idx) => ({ ...e, position: idx + 1 }));
  }

  fulfilledSlots() {
    const byBatch = new Map();
    for (const o of this.orders.values()) {
      if (o.status !== 'fulfilled') continue;
      if (!byBatch.has(o.batchKey)) byBatch.set(o.batchKey, []);
      byBatch.get(o.batchKey).push(o);
    }
    const slots = [...byBatch.entries()].map(([key, orders]) => {
      const first = orders[0];
      const reachedAts = orders.map((o) => o.reachedTopAt).filter(Boolean);
      return {
        key,
        buyer: first.buyer,
        buyerId: first.buyerId,
        orderIds: orders.map((o) => o.id),
        itemCount: orders.reduce((n, o) => n + o.items.reduce((m, i) => m + (i.qty || 1), 0), 0),
        total: orders.reduce((s, o) => s + o.total, 0),
        fulfilledAt: Math.max(...orders.map((o) => o.fulfilledAt || 0)),
        // Timing fields for the queue metrics.
        firstOrderAt: Math.min(...orders.map((o) => o.createdAt || o.fulfilledAt || 0)),
        reachedTopAt: reachedAts.length ? Math.min(...reachedAts) : null,
      };
    });
    slots.sort((a, b) => b.fulfilledAt - a.fulfilledAt);
    return slots;
  }

  stats() {
    const active = this.activeQueue();
    const done = this.fulfilledSlots();
    // Average time-in-queue (placed -> fulfilled) and fulfillment time (reached
    // top -> fulfilled) across everything fulfilled this stream.
    const inQueue = done
      .map((s) => (s.fulfilledAt && s.firstOrderAt) ? s.fulfilledAt - s.firstOrderAt : null)
      .filter((v) => v != null && v >= 0);
    const atTop = done
      .map((s) => (s.fulfilledAt && s.reachedTopAt) ? s.fulfilledAt - s.reachedTopAt : null)
      .filter((v) => v != null && v >= 0);
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    return {
      activeCount: active.length,
      priorityCount: active.filter((e) => e.isPriority).length,
      breakOpen: this.breaks.filter((b) => b.status === 'open').length,
      breakSpots: this.breakSummaries().filter((b) => b.status === 'open').reduce((n, b) => n + b.activeSpots, 0),
      fulfilledCount: done.length,
      activeValue: active.reduce((s, e) => s + e.total, 0),
      priorityItems: this.priorityItems,
      live: this.live,
      // Queue timing metrics (admin only). Milliseconds; null when no data yet.
      avgTimeInQueueMs: avg(inQueue),
      avgFulfillmentMs: avg(atTop),
      timedCount: inQueue.length,
    };
  }

  snapshot() {
    return {
      queue: this.activeQueue(),
      fulfilled: this.fulfilledSlots().slice(0, 50),
      cancelled: this.cancelledSlots().slice(0, 50),
      stats: this.stats(),
      config: { priorityItems: this.priorityItems, breakKeywords: this.breakKeywords, autoBreaks: this.autoBreaks, breakIgnore: this.breakIgnore },
      breaks: this.breakSummaries(),
      variants: this.trackedVariants.map((v) => ({
        id: v.id, label: v.label, product: v.product, variant: v.variant,
        count: this.variantCounts[v.id] || 0,
      })),
      variantLog: this.variantLog.slice(0, 50),
      streamStartAt: this.streamStartAt,
      streamEndAt: this.streamEndAt,
      clips: this.clips.slice().sort((a, b) => (a.at || 0) - (b.at || 0)),
      history: this.history.map((s) => ({
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        count: s.count,
        value: s.value,
        unfulfilledCount: s.unfulfilledCount || 0,
      })),
    };
  }

  reset() {
    this.orders.clear();
    this.openBatch.clear();
    this.breaks = [];
    this._persist();
    this.emit('change', { reason: 'reset' });
  }

  // ── Stream clip log (editor aid) ────────────────────────────────────────────
  /** Set the manually-entered stream start time (ms epoch), or null to clear.
   *  Clip elapsed times are computed against this. */
  setStreamStart(atMs) {
    const n = Number(atMs);
    this.streamStartAt = (Number.isFinite(n) && n > 0) ? Math.round(n) : null;
    this._persist();
    this.emit('change', { reason: 'stream-start', streamStartAt: this.streamStartAt });
    return this.streamStartAt;
  }

  /** Add a clip mark. Timestamp defaults to now (server clock) but an explicit
   *  epoch may be supplied. Returns the created clip. */
  addClip(atMs, note) {
    const n = Number(atMs);
    const at = (Number.isFinite(n) && n > 0) ? Math.round(n) : Date.now();
    const clip = { id: `clip${++this.clipCounter}`, at, note: String(note || '').slice(0, 500) };
    this.clips.push(clip);
    this._persist();
    this.emit('change', { reason: 'clip-add', id: clip.id });
    return clip;
  }

  /** Edit a clip's timestamp (ms epoch) and/or note. */
  updateClip(id, patch) {
    const c = this.clips.find((x) => x.id === String(id));
    if (!c) return null;
    if (patch && patch.at != null) {
      const n = Number(patch.at);
      if (Number.isFinite(n) && n > 0) c.at = Math.round(n);
    }
    if (patch && patch.note != null) c.note = String(patch.note).slice(0, 500);
    this._persist();
    this.emit('change', { reason: 'clip-update', id: c.id });
    return c;
  }

  removeClip(id) {
    const i = this.clips.findIndex((x) => x.id === String(id));
    if (i < 0) return false;
    this.clips.splice(i, 1);
    this._persist();
    this.emit('change', { reason: 'clip-remove', id: String(id) });
    return true;
  }

  clearClips() {
    this.clips = [];
    this._persist();
    this.emit('change', { reason: 'clips-clear' });
    return true;
  }

  /** Remove a whole slot from the queue WITHOUT fulfilling it (e.g. the buyer
   *  cancelled). Marked 'cancelled' so it drops out of the active queue and the
   *  fulfilled list, and shows in the Cancelled section for tracking. */
  removeSlot(batchKey) {
    const orders = [...this.orders.values()].filter(
      (o) => o.batchKey === batchKey && o.status === 'queued'
    );
    if (!orders.length) return null;
    const buyerId = orders[0].buyerId;
    const now = Date.now();
    for (const o of orders) { o.status = 'cancelled'; o.cancelledAt = now; o.bumped = false; }
    if (this.openBatch.get(buyerId) === batchKey) this.openBatch.delete(buyerId);
    this._markTopReached();
    this._persist();
    this.emit('change', { reason: 'cancelled', batchKey });
    return { batchKey };
  }

  /** Cancel a SINGLE order by its order id (used by the auto re-check when an
   *  order flips to CANCELLED on TikTok). Leaves any other orders in the same
   *  buyer's slot untouched. */
  cancelOrder(orderId) {
    const o = this.orders.get(String(orderId));
    if (!o || (o.status !== 'queued' && o.status !== 'break')) return null;
    o.status = 'cancelled';
    o.cancelledAt = Date.now();
    o.bumped = false;
    // If the buyer's open slot has no queued orders left, close it.
    const stillOpen = [...this.orders.values()].some(
      (x) => x.batchKey === o.batchKey && x.status === 'queued'
    );
    if (!stillOpen && this.openBatch.get(o.buyerId) === o.batchKey) this.openBatch.delete(o.buyerId);
    this._markTopReached();
    this._persist();
    this.emit('change', { reason: 'cancelled', orderId: String(orderId) });
    return o;
  }

  /** Cancelled slots (grouped by buyer batch) for the admin Cancelled section. */
  cancelledSlots() {
    const byBatch = new Map();
    for (const o of this.orders.values()) {
      if (o.status !== 'cancelled') continue;
      if (!byBatch.has(o.batchKey)) byBatch.set(o.batchKey, []);
      byBatch.get(o.batchKey).push(o);
    }
    const slots = [...byBatch.entries()].map(([key, orders]) => {
      const first = orders[0];
      return {
        key,
        buyer: first.buyer,
        buyerId: first.buyerId,
        orderIds: orders.map((o) => o.id),
        itemCount: orders.reduce((n, o) => n + this._allItems(o).reduce((m, i) => m + (i.qty || 1), 0), 0),
        total: orders.reduce((s, o) => s + this._fullTotal(o), 0),
        cancelledAt: Math.max(...orders.map((o) => o.cancelledAt || 0)),
        isBreak: orders.every((o) => o.breakOnly),
      };
    });
    slots.sort((a, b) => b.cancelledAt - a.cancelledAt);
    return slots;
  }

  // ── Breaks ─────────────────────────────────────────────────────────────────
  /** True if any break is open — the poller keeps listening offline then. */
  hasOpenBreaks() { return this.breaks.some((b) => b.status === 'open'); }

  _breakTitle(id) {
    const b = this.breaks.find((x) => x.id === id);
    return b ? b.title : 'Break';
  }

  /** Product name without the " - <variant>" suffix TikTok folds in
   *  ("Dragon Frontiers Galaxy Rips LT DADDY BREAK - Default" → product name). */
  _productName(it) {
    let n = String(it.name || '').trim();
    const v = String(it.variant || '').trim();
    if (v && n.toLowerCase().endsWith((' - ' + v).toLowerCase())) n = n.slice(0, n.length - v.length - 3).trim();
    return n || 'Break';
  }

  /** Spot count written in the product name, e.g. "(33 Spot)" / "33 Spots". */
  _capacityFrom(text) {
    const m = String(text || '').match(/(\d{1,4})\s*-?\s*spots?\b/i);
    const n = m ? Number(m[1]) : 0;
    return n > 0 ? n : null;
  }

  /** Whole-word phrase match, so "break" never matches "BREAKpoint" or
   *  "BREAKthrough" (real Pokémon set names). */
  _hasWord(text, phrase) {
    const p = String(phrase || '').toLowerCase().trim();
    if (!p) return false;
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(text);
  }

  /** Which break (if any) an item belongs to. Open breaks win (longest match
   *  first); otherwise, if the item has a break keyword, a new break is opened
   *  for that product (when create + autoBreaks). */
  _breakFor(it, create) {
    const text = `${it.name || ''} ${it.sku || ''}`.toLowerCase();
    if (this.breakIgnore.some((p) => p && text.includes(p))) return null;
    const open = this.breaks.filter((b) => b.status === 'open' && b.match && text.includes(b.match));
    if (open.length) return open.sort((a, b) => b.match.length - a.match.length)[0];
    if (!create || !this.autoBreaks) return null;
    if (!this.breakKeywords.some((k) => this._hasWord(text, k))) return null;
    const product = this._productName(it);
    const match = product.toLowerCase();
    const prior = this.breaks.filter((b) => b.match === match).length;
    const br = {
      id: 'brk' + (++this.breakCounter),
      title: prior ? `${product} #${prior + 1}` : product,
      match, status: 'open', auto: true, createdAt: Date.now(), rippedAt: null,
      capacity: this._capacityFrom(product),
    };
    this.breaks.push(br);
    return br;
  }

  /** Queue share of an order's total when some of its items went to a break:
   *  real per-item prices when captured, otherwise split by quantity. */
  _splitTotal(raw, queueItems) {
    const all = raw.items || [];
    const total = Number(raw.total || 0);
    const priced = all.length && all.every((i) => Number(i.price || 0) > 0);
    if (priced) return Math.round(queueItems.reduce((s, i) => s + Number(i.price) * (i.qty || 1), 0) * 100) / 100;
    const q = (arr) => arr.reduce((n, i) => n + (i.qty || 1), 0);
    const allQ = q(all);
    return allQ ? Math.round(total * (q(queueItems) / allQ) * 100) / 100 : total;
  }

  /** Breaks with their live entries, for the panel/public page/history. */
  breakSummaries() {
    const active = this.activeQueue();
    const posByKey = new Map(active.map((e) => [e.key, e.position]));
    return this.breaks.map((b) => {
      const entries = [];
      for (const o of this.orders.values()) {
        const its = (o.breakItems || []).filter((it) => it.breakId === b.id);
        if (!its.length) continue;
        const qty = its.reduce((n, it) => n + (it.qty || 1), 0);
        const value = its.reduce((n, it) => n + (Number(it.price) || 0) * (it.qty || 1), 0);
        // Does this buyer ALSO have something in the running queue? sameOrder =
        // the queue slot holds the rest of this very order.
        let queuePos = null; let sameOrder = false;
        if (o.status === 'queued') { queuePos = posByKey.get(o.batchKey) || null; sameOrder = true; }
        else {
          const k = this.openBatch.get(o.buyerId);
          if (k) queuePos = posByKey.get(k) || null;
        }
        entries.push({
          orderId: o.id, buyerId: o.buyerId, buyer: o.buyer, buyerHandle: o.buyerHandle || '',
          qty, value,
          items: its.map((it) => ({ name: it.name, qty: it.qty || 1, cancelled: !!it.cancelled })),
          createdAt: o.createdAt, status: o.status,
          cancelled: o.status === 'cancelled' || its.every((it) => it.cancelled),
          cancelRequested: !!o.cancelRequested, onHold: !!o.onHold,
          queuePos, sameOrder, queuePartFulfilled: o.status === 'fulfilled',
          mixed: (o.items || []).length > 0,
          done: (o.breakDone && o.breakDone[b.id]) || null,
          offline: !!o.offline,
          offlineItems: (o.offlineItems || []).map((it) => ({ name: it.name, qty: it.qty || 1 })),
        });
      }
      entries.sort((a, c) => (a.createdAt || 0) - (c.createdAt || 0));
      const live = entries.filter((e) => !e.cancelled);
      // Back-to-back rounds: with a spot total set, spots 1..cap are round 1,
      // cap+1..2cap round 2, and so on, in the order received. A round holds
      // EXACTLY cap spots — an order that runs past the end of a round is split,
      // the overflow becoming the first spot(s) of the next round. Each piece is
      // its own entry ("segment", key orderId:round) and is fulfilled separately.
      const cap = b.capacity > 0 ? b.capacity : null;
      let cum = 0;
      const segs = [];
      for (const e of entries) {
        if (e.cancelled) { segs.push({ ...e, segKey: `${e.orderId}:x`, round: null, spotStart: null, spotEnd: null, part: 1, parts: 1, orderQty: e.qty, done: null }); continue; }
        const o = this.orders.get(String(e.orderId));
        const legacy = (o && o.breakDone && o.breakDone[b.id]) || null; // whole-order done
        const doneMap = (o && o.breakDoneRounds && o.breakDoneRounds[b.id]) || {};
        const pieces = [];
        let left = e.qty;
        while (left > 0) {
          const round = cap ? Math.floor(cum / cap) + 1 : 1;
          const start = cap ? (cum % cap) + 1 : cum + 1;
          const take = cap ? Math.min(left, cap - (cum % cap)) : left;
          pieces.push({ round, start, take });
          cum += take; left -= take;
        }
        pieces.forEach((p, i) => segs.push({
          ...e,
          qty: p.take,
          value: e.qty ? Math.round(e.value * p.take / e.qty * 100) / 100 : 0,
          segKey: `${e.orderId}:${p.round}`,
          round: p.round, spotStart: p.start, spotEnd: p.start + p.take - 1,
          part: i + 1, parts: pieces.length, orderQty: e.qty,
          done: legacy || doneMap[p.round] || null,
        }));
      }
      entries.length = 0; entries.push(...segs);
      live.length = 0; live.push(...segs.filter((e) => !e.cancelled));
      const rounds = [];
      for (const e of live) {
        let r = rounds[e.round - 1];
        if (!r) { r = rounds[e.round - 1] = { n: e.round, spots: 0, doneSpots: 0, entries: 0, doneEntries: 0 }; }
        r.spots += e.qty; r.entries++;
        if (e.done) { r.doneSpots += e.qty; r.doneEntries++; }
      }
      const doneSpots = live.filter((e) => e.done).reduce((n, e) => n + e.qty, 0);
      const cur = rounds.length ? rounds[rounds.length - 1] : null;
      return {
        ...b, entries,
        spots: live.reduce((n, e) => n + e.qty, 0),
        doneSpots,
        activeSpots: live.reduce((n, e) => n + e.qty, 0) - doneSpots,
        value: Math.round(live.reduce((n, e) => n + e.value, 0) * 100) / 100,
        buyers: new Set(live.map((e) => e.buyerId)).size,
        rounds: rounds.filter(Boolean),
        currentRound: cur ? cur.n : 1,
        // Spots taken in the round currently filling (a full round means the
        // next order starts the next round).
        currentRoundSpots: cur ? cur.spots : 0,
      };
    });
  }

  /** Manually open a break. Anything already sitting in the queue that matches
   *  is pulled out of the queue into the break. */
  createBreak({ title, match, capacity } = {}) {
    const t = String(title || match || '').trim();
    const m = String(match || title || '').trim().toLowerCase();
    if (!t || !m) return null;
    this.breakIgnore = this.breakIgnore.filter((p) => p !== m);
    const cap = Math.floor(Number(capacity));
    const br = { id: 'brk' + (++this.breakCounter), title: t.slice(0, 120), match: m, status: 'open', auto: false, createdAt: Date.now(), rippedAt: null, capacity: cap > 0 ? cap : this._capacityFrom(t) };
    this.breaks.push(br);
    let moved = 0;
    for (const o of this.orders.values()) {
      if (o.status !== 'queued') continue;
      const keep = []; const take = [];
      for (const it of (o.items || [])) {
        const text = `${it.name || ''} ${it.sku || ''}`.toLowerCase();
        (text.includes(m) ? take : keep).push(it);
      }
      if (!take.length) continue;
      moved += take.length;
      o.breakItems = [...(o.breakItems || []), ...take.map((it) => ({ ...it, breakId: br.id }))];
      if (o.fullTotal == null) o.fullTotal = o.total;
      o.items = keep;
      o.total = keep.length ? this._splitTotal({ items: [...keep, ...o.breakItems], total: o.fullTotal }, keep) : o.fullTotal;
      o.hasPriority = this._isPriorityOrder(keep);
      if (!keep.length) {
        const oldKey = o.batchKey;
        o.status = 'break'; o.breakOnly = true; o.batchKey = `brk:${o.id}`; o.bumped = false;
        const still = [...this.orders.values()].some((x) => x.batchKey === oldKey && x.status === 'queued');
        if (!still && this.openBatch.get(o.buyerId) === oldKey) this.openBatch.delete(o.buyerId);
      }
    }
    this._markTopReached();
    this._persist();
    this.emit('change', { reason: 'break-create', id: br.id, moved });
    return br;
  }

  renameBreak(id, title) {
    const b = this.breaks.find((x) => x.id === String(id));
    const t = String(title || '').trim();
    if (!b || !t) return null;
    b.title = t.slice(0, 120);
    this._persist();
    this.emit('change', { reason: 'break-rename', id: b.id });
    return b;
  }

  /** Mark break entries (one per order) fulfilled — or undo with done=false.
   *  Each order's spots in this break are fulfilled together. */
  setBreakEntriesDone(id, keys, done = true) {
    const b = this.breaks.find((x) => x.id === String(id));
    if (!b) return null;
    const now = Date.now();
    let n = 0;
    // Each key is "orderId:round" (one round's piece of an order) or a bare
    // orderId (all of that order's spots in this break).
    const summary = this.breakSummaries().find((x) => x.id === b.id);
    const roundsOf = (oid) => (summary ? summary.entries : [])
      .filter((e) => String(e.orderId) === oid && !e.cancelled).map((e) => e.round);
    for (const key of (Array.isArray(keys) ? keys : [keys])) {
      const [oid, r] = String(key).split(':');
      const o = this.orders.get(oid);
      if (!o || !(o.breakItems || []).some((it) => it.breakId === b.id)) continue;
      o.breakDone = o.breakDone || {};
      o.breakDoneRounds = o.breakDoneRounds || {};
      const m = o.breakDoneRounds[b.id] = o.breakDoneRounds[b.id] || {};
      if (!r) {
        if (done) { for (const rr of roundsOf(oid)) if (!m[rr] && !o.breakDone[b.id]) { m[rr] = now; n++; } }
        else { if (o.breakDone[b.id]) { delete o.breakDone[b.id]; n++; } for (const rr of Object.keys(m)) { delete m[rr]; n++; } }
        continue;
      }
      const round = Number(r);
      if (o.breakDone[b.id]) {
        // Legacy whole-order flag: expand it into per-round flags first.
        for (const rr of roundsOf(oid)) m[rr] = m[rr] || o.breakDone[b.id];
        delete o.breakDone[b.id];
      }
      if (done) { if (!m[round]) { m[round] = now; n++; } }
      else if (m[round]) { delete m[round]; n++; }
    }
    if (n) {
      this._persist();
      this.emit('change', { reason: done ? 'break-done' : 'break-undone', id: b.id, count: n });
    }
    return { count: n };
  }

  /** Order ids whose every break spot (all rounds, all breaks) is fulfilled. */
  _doneBreakOrderIds() {
    const pending = new Set(); const seen = new Set();
    for (const b of this.breakSummaries()) {
      for (const e of b.entries) {
        if (e.cancelled) continue;
        seen.add(String(e.orderId));
        if (!e.done) pending.add(String(e.orderId));
      }
    }
    return new Set([...seen].filter((id) => !pending.has(id)));
  }

  /** Merge one break into another (e.g. a break was closed by mistake and new
   *  orders opened a "#2"). Entries keep their order-received position. */
  mergeBreak(fromId, intoId) {
    const from = this.breaks.find((x) => x.id === String(fromId));
    const into = this.breaks.find((x) => x.id === String(intoId));
    if (!from || !into || from === into) return null;
    let moved = 0;
    for (const o of this.orders.values()) {
      for (const it of (o.breakItems || [])) if (it.breakId === from.id) { it.breakId = into.id; moved++; }
      if (o.breakDone && o.breakDone[from.id]) { o.breakDone[into.id] = o.breakDone[into.id] || o.breakDone[from.id]; delete o.breakDone[from.id]; }
      // Round numbers differ between breaks, so per-round flags can't carry over.
      if (o.breakDoneRounds && o.breakDoneRounds[from.id]) delete o.breakDoneRounds[from.id];
    }
    this.breaks = this.breaks.filter((x) => x.id !== from.id);
    this._persist();
    this.emit('change', { reason: 'break-merge', from: from.id, into: into.id, moved });
    return { moved };
  }

  /** Bring unfinished breaks back from a past stream (e.g. the live was ended
   *  before a break finished, which archives and clears it). Rebuilds each
   *  break that still had un-fulfilled spots — same title/match/spot total —
   *  with ALL its entries in their original order, keeping fulfilled marks, so
   *  round/spot numbering carries on exactly. Queue (non-break) items are not
   *  restored. apply=false is a dry run that only reports what would happen. */
  restoreBreaksFromHistory(histId, apply = false) {
    const h = this.history.find((x) => String(x.id) === String(histId)) || (histId ? null : this.history[0]);
    if (!h) return { ok: false, error: 'stream not found' };
    const recs = new Map();
    for (const r of [...(h.unfulfilled || []), ...(h.fulfilled || [])]) recs.set(String(r.orderId), r);
    const stripTitle = (t) => String(t || '').replace(/\s*#\d+\s*$/, '').replace(/\s*\(\d{1,4}\s*-?\s*spots?\)\s*$/i, '').trim();
    const report = [];
    for (const hb of (h.breaks || [])) {
      const entries = hb.entries || [];
      const pending = entries.filter((e) => !e.cancelled && !e.done);
      if (!pending.length) continue;
      const match = stripTitle(hb.title).toLowerCase();
      // Spot total: from the title, else from the item names ("(100 Spot)").
      let capacity = this._capacityFrom(hb.title);
      if (!capacity) for (const e of entries) for (const it of (e.items || [])) capacity = Math.max(capacity || 0, this._capacityFrom(it.name) || 0) || null;
      // One restored order per archived order id, in archive (received) order.
      const orderIds = [...new Set(entries.filter((e) => !e.cancelled).map((e) => String(e.orderId)))];
      let lastT = Number(h.startedAt) || 0; let k = 0;
      const plan = [];
      for (const oid of orderIds) {
        const segs = entries.filter((e) => String(e.orderId) === oid && !e.cancelled);
        const r = recs.get(oid);
        const items = ((r && r.items) || segs[0].items || []).filter((it) => it.breakId ? it.breakId === hb.id : String(it.name || '').toLowerCase().includes(match));
        let createdAt = r && r.createdAt ? Number(r.createdAt) : null;
        if (createdAt && createdAt >= lastT) { lastT = createdAt; k = 0; } else createdAt = lastT + (++k);
        const doneRounds = {};
        for (const sg of segs) if (sg.done && sg.round) doneRounds[sg.round] = sg.done;
        plan.push({
          id: oid, buyerId: (r && r.buyerId) || ('restored:' + oid), buyer: (r && r.buyer) || segs[0].buyer || 'Buyer',
          items: items.map(({ breakId: _b, break: _t, ...it }) => it), createdAt, doneRounds,
          spots: segs.reduce((n, sg) => n + (sg.qty || 0), 0),
          total: items.reduce((s, it) => s + (Number(it.price) || 0) * (it.qty || 1), 0) || (r ? Number(r.total || 0) : 0),
        });
      }
      const existing = this.breaks.find((b) => b.status === 'open' && b.match === match);
      const skip = plan.filter((p) => this.orders.has(p.id));
      report.push({
        title: hb.title, match, capacity,
        orders: plan.length, spots: plan.reduce((n, p) => n + p.spots, 0),
        doneSpots: entries.filter((e) => !e.cancelled && e.done).reduce((n, e) => n + (e.qty || 0), 0),
        pendingSpots: pending.reduce((n, e) => n + (e.qty || 0), 0),
        alreadyPresent: skip.length, into: existing ? existing.id : 'new break',
      });
      if (!apply) continue;
      let br = existing;
      if (!br) {
        br = { id: 'brk' + (++this.breakCounter), title: hb.title, match, status: 'open', auto: false, createdAt: Date.now(), rippedAt: null, capacity, restoredFrom: String(h.id) };
        this.breaks.push(br);
        this.breakIgnore = this.breakIgnore.filter((p) => p !== match);
      } else if (!br.capacity && capacity) br.capacity = capacity;
      for (const p of plan) {
        if (this.orders.has(p.id)) continue;
        const o = {
          id: p.id, buyerId: p.buyerId, buyer: p.buyer, buyerHandle: '',
          items: [], breakItems: p.items.map((it) => ({ ...it, breakId: br.id })),
          total: p.total, fullTotal: p.total, createdAt: p.createdAt, receivedAt: Date.now(),
          status: 'break', batchKey: `brk:${p.id}`, breakOnly: true, hasPriority: false,
          onHold: false, cancelRequested: false, restored: true,
        };
        if (Object.keys(p.doneRounds).length) o.breakDoneRounds = { [br.id]: p.doneRounds };
        this.orders.set(p.id, o);
      }
    }
    if (apply && report.length) {
      this._persist();
      this.emit('change', { reason: 'break-restore', from: String(h.id) });
    }
    return { ok: true, stream: String(h.id), applied: !!apply, breaks: report };
  }

  /** Set (or clear, with blank/0) how many spots a break has. */
  setBreakCapacity(id, n) {
    const b = this.breaks.find((x) => x.id === String(id));
    if (!b) return null;
    const v = Math.floor(Number(n));
    b.capacity = v > 0 ? Math.min(v, 9999) : null;
    this._persist();
    this.emit('change', { reason: 'break-capacity', id: b.id });
    return b;
  }

  /** Mark a break ripped (done). New orders for the same product after this
   *  open a fresh break (#2, #3 …). Reopen undoes it. */
  setBreakRipped(id, ripped) {
    const b = this.breaks.find((x) => x.id === String(id));
    if (!b) return null;
    b.status = ripped ? 'ripped' : 'open';
    b.rippedAt = ripped ? Date.now() : null;
    this._persist();
    this.emit('change', { reason: ripped ? 'break-ripped' : 'break-reopen', id: b.id });
    return b;
  }

  /** Move one order's items for a break back into the running queue. */
  _unbreakOrder(o, breakId) {
    const back = (o.breakItems || []).filter((it) => it.breakId === breakId);
    if (!back.length) return false;
    o.breakItems = (o.breakItems || []).filter((it) => it.breakId !== breakId);
    o.items = [...(o.items || []), ...back.map(({ breakId: _b, ...it }) => it)];
    o.hasPriority = this._isPriorityOrder(o.items);
    o.total = o.breakItems.length ? this._splitTotal({ items: [...o.items, ...o.breakItems], total: this._fullTotal(o) }, o.items) : this._fullTotal(o);
    if (o.status === 'break') {
      let key = this.openBatch.get(o.buyerId);
      if (!key) { key = `${o.buyerId}#${++this.batchCounter}`; this.openBatch.set(o.buyerId, key); }
      o.batchKey = key; o.status = 'queued'; o.breakOnly = false;
    }
    return true;
  }

  /** Send a single entry's break items to the running queue (wrong match). */
  moveBreakEntryToQueue(id, orderId) {
    const o = this.orders.get(String(orderId));
    if (!o || !this._unbreakOrder(o, String(id))) return null;
    this._markTopReached();
    this._persist();
    this.emit('change', { reason: 'break-entry-to-queue', id: String(id), orderId: String(orderId) });
    return o;
  }

  /** "Not a break": put every entry back into the running queue, delete the
   *  break, and stop auto-detecting that product as a break. */
  dissolveBreak(id) {
    const b = this.breaks.find((x) => x.id === String(id));
    if (!b) return null;
    for (const o of this.orders.values()) {
      if (o.status === 'queued' || o.status === 'break') this._unbreakOrder(o, b.id);
    }
    this.breaks = this.breaks.filter((x) => x.id !== b.id);
    if (b.auto && b.match && !this.breakIgnore.includes(b.match)) this.breakIgnore.push(b.match);
    this._markTopReached();
    this._persist();
    this.emit('change', { reason: 'break-dissolve', id: b.id });
    return { id: b.id };
  }

  setBreakConfig({ keywords, auto, ignore } = {}) {
    if (Array.isArray(keywords)) this.breakKeywords = keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
    if (auto != null) this.autoBreaks = !!auto;
    if (Array.isArray(ignore)) this.breakIgnore = ignore.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
    this._persist();
    this.emit('change', { reason: 'break-config' });
    return { breakKeywords: this.breakKeywords, autoBreaks: this.autoBreaks, breakIgnore: this.breakIgnore };
  }

  /** Inject a synthetic order for testing (e.g. label printing) regardless of
   *  live state. Behaves like a real ingest otherwise (merges by buyer, etc.). */
  injectTestOrder(raw) {
    const wasLive = this.live;
    this.live = true;
    const order = this.upsertOrder(raw);
    this.live = wasLive;
    this._persist();
    this.emit('change', { reason: 'test-order' });
    return order;
  }
}
