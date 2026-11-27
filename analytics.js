// Shared, dependency-free analytics. Imported by the server (Excel exports) AND
// served to the browser (reports, back office, metrics) so every screen and every
// export computes money the same way.
//
// Money model per sold line (cancelled lines/orders are excluded):
//   gross      = unit price × qty (what the buyer paid for the item, before shipping/tax)
//   tiktokFee  = gross × TikTok fee %
//   commission = gross × streamer commission %
//   shipping   = ESTIMATE per order (fixed $ or % of the order), spread across the
//                order's lines by their share of the order's gross
//   cogs       = unit cost × qty for OWN stock (blank if no cost entered)
//   payout     = consignee's cut for CONSIGNED items (pct of gross or fixed $/unit)
//   net        = gross − tiktokFee − commission − shipping − cogs − payout

export const PRICE_BANDS = [
  [0, 25], [25, 50], [50, 100], [100, 250], [250, 500], [500, 1000],
  [1000, 2000], [2000, 3000], [3000, 5000], [5000, Infinity],
];
export function bandLabel(b) {
  const f = (n) => '$' + (n >= 1000 ? (n / 1000) + 'k' : n);
  return b[1] === Infinity ? f(b[0]) + '+' : f(b[0]) + '–' + f(b[1]);
}
export function bandOf(price) {
  const p = Number(price) || 0;
  for (const b of PRICE_BANDS) if (p >= b[0] && p < b[1]) return bandLabel(b);
  return bandLabel(PRICE_BANDS[0]);
}

export function normName(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
export function itemKey(it) {
  if (it && it.skuId) return 'sku:' + String(it.skuId);
  if (it && it.productId) return 'prod:' + String(it.productId);
  return 'name:' + normName(it && it.name);
}
/** Current terms for a line from the back-office item map (SKU > product > name). */
export function termsFromMap(items, it) {
  const keys = [];
  if (it.skuId) keys.push('sku:' + it.skuId);
  if (it.productId) keys.push('prod:' + it.productId);
  keys.push('name:' + normName(it.name));
  const out = {};
  for (const k of keys.slice().reverse()) {
    const t = items && items[k];
    if (!t) continue;
    for (const [f, v] of Object.entries(t)) if (v !== undefined && v !== null && v !== '') out[f] = v;
  }
  return out;
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---- time parts in the store's timezone ----
const _fmtCache = {};
export function tzParts(ms, tz = 'America/New_York') {
  let f = _fmtCache[tz];
  if (!f) {
    f = _fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
  }
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const year = +p.year, month = +p.month, day = +p.day, hour = +p.hour % 24;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const date = `${p.year}-${p.month}-${p.day}`;
  // Week starting Monday, labelled by its Monday date.
  const d = new Date(Date.UTC(year, month - 1, day));
  const back = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  const week = d.toISOString().slice(0, 10);
  return { year, month, day, hour, dow, date, week, quarter: Math.floor((month - 1) / 3) + 1 };
}

/** Per-order economics. termsOf(line) → current item terms. */
export function orderEconomics(order, settings, termsOf) {
  const s = settings || {};
  const live = (order.items || []).filter((it) => !it.cancelled);
  const cancelled = order.status === 'cancelled';
  let lines = live.map((it) => ({ ...it, gross: (Number(it.price) || 0) * (Number(it.qty) || 1) }));
  let orderGross = lines.reduce((a, l) => a + l.gross, 0);
  // Older records without per-item prices: spread the order total by quantity.
  if (!orderGross && Number(order.total) > 0 && lines.length) {
    const units = lines.reduce((a, l) => a + (Number(l.qty) || 1), 0);
    lines = lines.map((l) => ({ ...l, gross: Number(order.total) * (Number(l.qty) || 1) / units, priceEstimated: true }));
    orderGross = Number(order.total);
  }
  const shipTotal = cancelled || !orderGross ? 0
    : (s.shippingMode === 'pct' ? orderGross * (Number(s.shippingPct) || 0) / 100 : Number(s.shippingFixed) || 0);
  const out = lines.map((l) => {
    const t = termsOf ? termsOf(l) : {};
    const cs = l.cs || (t.consigned ? { consignee: t.consignee || '', splitType: t.splitType || 'pct', splitValue: Number(t.splitValue) || 0 } : null);
    const qty = Number(l.qty) || 1;
    const gross = cancelled ? 0 : l.gross;
    const tiktokFee = gross * (Number(s.tiktokFeePct) || 0) / 100;
    const commission = gross * (Number(s.streamerPct) || 0) / 100;
    const shipping = orderGross ? shipTotal * (l.gross / orderGross) : 0;
    const costKnown = !cs && t.cost != null && t.cost !== '';
    const cogs = cs ? 0 : (costKnown ? Number(t.cost) * qty : 0);
    const payout = !cs || cancelled ? 0 : (cs.splitType === 'fixed' ? Number(cs.splitValue) * qty : gross * Number(cs.splitValue) / 100);
    const net = gross - tiktokFee - commission - shipping - cogs - payout;
    return {
      name: l.name, key: itemKey(l), productId: l.productId || '', skuId: l.skuId || '', sku: l.sku || '',
      qty: cancelled ? 0 : qty, unitPrice: qty ? l.gross / qty : 0, gross: r2(gross),
      tiktokFee: r2(tiktokFee), commission: r2(commission), shipping: r2(shipping),
      cogs: r2(cogs), costKnown: !!(cs || costKnown), payout: r2(payout), net: r2(net),
      consigned: !!cs, consignee: cs ? cs.consignee : '', priceEstimated: !!l.priceEstimated,
    };
  });
  return { lines: out, gross: r2(out.reduce((a, l) => a + l.gross, 0)), shipping: r2(shipTotal) };
}

/** Flatten orders to one fact row per sold line, with time parts. */
export function buildFacts(orders, settings, termsOf) {
  const tz = (settings && settings.timezone) || 'America/New_York';
  const facts = [];
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    const tp = tzParts(o.createdAt, tz);
    const eco = orderEconomics(o, settings, termsOf);
    eco.lines.forEach((l, i) => {
      if (!l.qty) return;
      facts.push({
        ...l, orderId: o.id, line: i, t: o.createdAt, ...tp,
        buyer: o.buyer, buyerHandle: o.buyerHandle || '', buyerKey: o.buyerId || o.buyer,
        channel: o.channel || 'live', streamId: o.streamId || null,
        band: bandOf(l.unitPrice),
      });
    });
  }
  return facts;
}

export function emptyAgg() {
  return { orders: new Set(), buyers: new Set(), units: 0, gross: 0, tiktokFee: 0, commission: 0, shipping: 0,
    cogs: 0, payout: 0, net: 0, consGross: 0, consPayout: 0, consNet: 0, ownGross: 0, ownNet: 0, uncosted: 0 };
}
export function addFact(a, f) {
  a.orders.add(f.orderId); a.buyers.add(f.buyerKey);
  a.units += f.qty; a.gross += f.gross; a.tiktokFee += f.tiktokFee; a.commission += f.commission;
  a.shipping += f.shipping; a.cogs += f.cogs; a.payout += f.payout; a.net += f.net;
  if (f.consigned) { a.consGross += f.gross; a.consPayout += f.payout; a.consNet += f.net; }
  else { a.ownGross += f.gross; a.ownNet += f.net; if (!f.costKnown) a.uncosted += f.gross; }
  return a;
}
export function finishAgg(a) {
  return {
    orders: a.orders.size, buyers: a.buyers.size, units: a.units,
    gross: r2(a.gross), tiktokFee: r2(a.tiktokFee), commission: r2(a.commission), shipping: r2(a.shipping),
    cogs: r2(a.cogs), payout: r2(a.payout), net: r2(a.net),
    consGross: r2(a.consGross), consPayout: r2(a.consPayout), consNet: r2(a.consNet),
    ownGross: r2(a.ownGross), ownNet: r2(a.ownNet), uncosted: r2(a.uncosted),
    aov: a.orders.size ? r2(a.gross / a.orders.size) : 0,
    margin: a.gross ? Math.round((a.net / a.gross) * 1000) / 10 : 0,
  };
}
export function aggregate(facts, keyFn) {
  const m = new Map();
  for (const f of facts) {
    const k = keyFn(f);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, emptyAgg());
    addFact(m.get(k), f);
  }
  return [...m.entries()].map(([key, a]) => ({ key, ...finishAgg(a) }));
}

export const PERIODS = {
  day: (f) => f.date,
  week: (f) => 'Week of ' + f.week,
  month: (f) => `${f.year}-${String(f.month).padStart(2, '0')}`,
  quarter: (f) => `${f.year} Q${f.quarter}`,
  year: (f) => String(f.year),
  stream: (f) => f.streamId ? 'stream:' + f.streamId : 'Offline (no stream)',
  all: () => 'All',
};

/** The after-action report for one stream. */
export function streamReport(stream, orders, settings, termsOf) {
  const tz = (settings && settings.timezone) || 'America/New_York';
  const placed = orders.filter((o) => o.status !== 'cancelled');
  const cancelled = orders.filter((o) => o.status === 'cancelled');
  const facts = buildFacts(placed, settings, termsOf);
  const totals = finishAgg(facts.reduce(addFact, emptyAgg()));
  // Buyers: every unique username, their orders + items + spend.
  const byBuyer = new Map();
  for (const o of placed) {
    const k = o.buyerId || o.buyer;
    if (!byBuyer.has(k)) byBuyer.set(k, { buyer: o.buyer, handle: o.buyerHandle || '', orders: [], spend: 0, units: 0 });
    const b = byBuyer.get(k);
    const eco = orderEconomics(o, settings, termsOf);
    b.orders.push({
      id: o.id, createdAt: o.createdAt, total: eco.gross,
      items: eco.lines.filter((l) => l.qty).map((l) => ({ name: l.name, qty: l.qty, gross: l.gross, consigned: l.consigned })),
    });
    b.spend += eco.gross;
    b.units += eco.lines.reduce((n, l) => n + l.qty, 0);
  }
  const buyers = [...byBuyer.values()]
    .map((b) => ({ ...b, spend: r2(b.spend), orders: b.orders.sort((x, y) => x.createdAt - y.createdAt) }))
    .sort((a, b) => b.spend - a.spend || a.buyer.localeCompare(b.buyer));
  const items = aggregate(facts, (f) => f.name).sort((a, b) => b.gross - a.gross);
  const consignees = aggregate(facts.filter((f) => f.consigned), (f) => f.consignee || 'Unnamed consignee').sort((a, b) => b.gross - a.gross);
  const consItems = aggregate(facts.filter((f) => f.consigned), (f) => f.name).sort((a, b) => b.gross - a.gross);
  const hours = aggregate(facts, (f) => f.hour).sort((a, b) => a.key - b.key);
  return {
    id: stream.id, startedAt: stream.startedAt, endedAt: stream.endedAt, tz,
    durationMs: stream.endedAt && stream.startedAt ? stream.endedAt - stream.startedAt : null,
    totals, buyers, items, consignees, consItems, hours,
    cancelled: cancelled.map((o) => ({ id: o.id, buyer: o.buyer, total: r2(o.total), items: (o.items || []).map((i) => ({ name: i.name, qty: i.qty })) })),
    breaks: (stream.breaks || []).map((b) => ({ title: b.title, spots: b.spots, value: b.value, status: b.status, buyers: new Set((b.entries || []).filter((e) => !e.cancelled).map((e) => e.buyer)).size })),
    settings,
    priceEstimated: facts.some((f) => f.priceEstimated),
    seeded: !!stream.seeded,
  };
}
