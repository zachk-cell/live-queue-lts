// Routes for: offline orders, after-action reports, the locked back office
// (inventory / cost / consignment / profitability / exports / metrics), the
// live chat feed, and the changelog page.
//
// Security: everything here needs the normal admin login. The back office ALSO
// needs its own password (BACKOFFICE_PASSWORD env, or one set on first use and
// stored hashed on disk), held in a separate short-lived cookie.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { streamReport, termsFromMap, itemKey, normName } from './analytics.js';
import { aarWorkbook, customExportWorkbook } from './reports.js';
import { fetchCatalog, updateSkuPrice, updateSkuStock, fetchOrdersRange, productScopeHint } from './tiktok.js';

const BO_TTL_MS = 12 * 3600 * 1000; // back-office unlock lasts 12h

export function mountBackoffice(app, { queue, ledger, chat, requireAuth, sendAdminPage, isAuthed, ADMIN, SESSION_SECRET, dir, panelNs }) {
  const boSecret = crypto.createHmac('sha256', SESSION_SECRET).update('backoffice').digest('hex');
  const cookie = (req, name) => {
    const h = req.headers.cookie || '';
    for (const c of h.split(';')) { const [k, ...v] = c.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')); }
    return '';
  };
  // Token embeds a fingerprint of the current password, so changing the
  // password instantly signs every other session out of the back office.
  const pwFp = () => crypto.createHash('sha256').update(String(process.env.BACKOFFICE_PASSWORD || (ledger.bo.password && ledger.bo.password.hash) || '')).digest('hex').slice(0, 16);
  const makeBo = () => { const p = `${Date.now()}.${pwFp()}`; return p + '.' + crypto.createHmac('sha256', boSecret).update(p).digest('hex'); };
  const boOk = (req) => {
    const t = cookie(req, 'ltsbo');
    const parts = t.split('.');
    if (parts.length !== 3) return false;
    const p = parts[0] + '.' + parts[1];
    const exp = crypto.createHmac('sha256', boSecret).update(p).digest('hex');
    try { if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(exp))) return false; } catch { return false; }
    return parts[1] === pwFp() && Date.now() - Number(parts[0]) < BO_TTL_MS;
  };
  const requireBo = (req, res, next) => (boOk(req) ? next() : res.status(401).json({ error: 'locked' }));
  const setBoCookie = (res) => res.setHeader('Set-Cookie', `ltsbo=${makeBo()}; HttpOnly; Secure; Path=/; Max-Age=${BO_TTL_MS / 1000}; SameSite=Strict`);
  const termsOf = (l) => termsFromMap(ledger.bo.items, l);
  const fails = new Map(); // ip -> { n, until } — slow down password guessing

  // ---------- shared analytics module for the browser ----------
  app.get('/static/analytics.js', requireAuth, (_req, res) => res.type('application/javascript').sendFile(path.join(dir, 'analytics.js')));

  // ---------- Offline orders ----------
  app.get('/api/offline', requireAuth, (_req, res) => res.json({ orders: queue.offlineOrders() }));
  app.post('/api/offline/done', requireAuth, (req, res) =>
    res.json({ ok: true, ...queue.setOfflineDone((req.body && req.body.orderIds) || [], req.body && req.body.done !== false) }));

  // ---------- After-action reports ----------
  app.get(ADMIN + '/reports', (req, res) => sendAdminPage(res, isAuthed(req) ? 'reports.html' : 'login.html'));
  app.get('/api/reports', requireAuth, (_req, res) => {
    const list = ledger.streamList().map((s) => {
      const r = streamReport(s, ledger.ordersForStream(s.id), ledger.bo.settings, termsOf);
      return { id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, orders: r.totals.orders, buyers: r.totals.buyers,
        units: r.totals.units, gross: r.totals.gross, net: r.totals.net, consGross: r.totals.consGross, seeded: !!s.seeded };
    });
    res.json({ streams: list, tz: ledger.bo.settings.timezone });
  });
  app.get('/api/reports/:id', requireAuth, (req, res) => {
    const s = ledger.streams[String(req.params.id)];
    if (!s) return res.status(404).json({ error: 'stream not found' });
    res.json(streamReport(s, ledger.ordersForStream(s.id), ledger.bo.settings, termsOf));
  });
  app.get('/api/reports/:id/xlsx', requireAuth, async (req, res) => {
    try {
      const out = await aarWorkbook(ledger, req.params.id);
      if (!out) return res.status(404).send('stream not found');
      const day = new Date(out.rep.startedAt || Date.now()).toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="LTs-after-action-report-${day}.xlsx"`);
      await out.wb.xlsx.write(res); res.end();
    } catch (e) { console.error('[reports] xlsx failed:', e); res.status(500).send('export failed: ' + e.message); }
  });

  // ---------- Changelog ----------
  app.get(ADMIN + '/changelog', (req, res) => {
    if (!isAuthed(req)) return sendAdminPage(res, 'login.html');
    let md = '';
    try { md = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'); } catch { md = '# Changelog\n\nNo entries yet.'; }
    res.type('html').send(changelogPage(md, ADMIN));
  });

  // ---------- Live chat ----------
  app.get('/api/chat', requireAuth, (_req, res) => res.json({ status: chat.status(), messages: chat.recent(150), username: ledger.bo.chatUsername || process.env.TIKTOK_LIVE_USERNAME || '' }));
  app.post('/api/chat/username', requireAuth, (req, res) => {
    const u = String((req.body && req.body.username) || '').replace(/^@/, '').trim().slice(0, 40);
    ledger.bo.chatUsername = u; ledger.saveBo();
    if (u && queue.live) chat.start().catch(() => {}); else if (!u) chat.stop().catch(() => {});
    res.json({ ok: true, username: u });
  });
  app.post('/api/chat/connect', requireAuth, (_req, res) => { chat.start().catch(() => {}); res.json({ ok: true }); });
  app.post('/api/chat/disconnect', requireAuth, (_req, res) => { chat.stop().catch(() => {}); res.json({ ok: true }); });

  // ---------- Back office (second password) ----------
  app.get(ADMIN + '/backoffice', (req, res) => sendAdminPage(res, isAuthed(req) ? 'backoffice.html' : 'login.html'));
  app.get('/api/bo/status', requireAuth, (req, res) => res.json({ unlocked: boOk(req), password: ledger.passwordSource() }));
  app.post('/api/bo/login', requireAuth, (req, res) => {
    const ip = req.ip || 'x';
    const f = fails.get(ip);
    if (f && f.until > Date.now()) return res.status(429).json({ ok: false, error: 'Too many tries — wait a minute.' });
    if (ledger.passwordSource() === 'unset') return res.status(400).json({ ok: false, error: 'No back-office password yet — create one first.' });
    if (!ledger.checkPassword(req.body && req.body.password)) {
      const n = (f ? f.n : 0) + 1;
      fails.set(ip, { n, until: n >= 5 ? Date.now() + 60000 : 0 });
      return res.status(401).json({ ok: false, error: 'Wrong password.' });
    }
    fails.delete(ip);
    setBoCookie(res);
    res.json({ ok: true });
  });
  app.post('/api/bo/setup', requireAuth, (req, res) => {
    if (ledger.passwordSource() !== 'unset') return res.status(400).json({ ok: false, error: 'A password is already set.' });
    if (!ledger.setPassword(req.body && req.body.password)) return res.status(400).json({ ok: false, error: 'Use at least 8 characters.' });
    setBoCookie(res);
    res.json({ ok: true });
  });
  app.post('/api/bo/password', requireAuth, requireBo, (req, res) => {
    if (ledger.passwordSource() === 'env') return res.status(400).json({ ok: false, error: 'The password is set in Render (BACKOFFICE_PASSWORD) — change it there.' });
    if (!ledger.checkPassword(req.body && req.body.current)) return res.status(401).json({ ok: false, error: 'Current password is wrong.' });
    if (!ledger.setPassword(req.body && req.body.next)) return res.status(400).json({ ok: false, error: 'Use at least 8 characters.' });
    setBoCookie(res);
    res.json({ ok: true });
  });
  app.post('/api/bo/lock', requireAuth, (_req, res) => { res.setHeader('Set-Cookie', 'ltsbo=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Strict'); res.json({ ok: true }); });

  // Everything the back-office page needs in one call.
  app.get('/api/bo/data', requireAuth, requireBo, (_req, res) => {
    // Items seen in sales (works before the product scope exists).
    const seen = new Map();
    for (const o of Object.values(ledger.orders)) {
      for (const it of (o.items || [])) {
        const k = itemKey(it);
        if (!seen.has(k)) seen.set(k, { key: k, name: it.name, productId: it.productId || '', skuId: it.skuId || '', sku: it.sku || '', units: 0, gross: 0, firstSale: o.createdAt, lastSale: o.createdAt, prices: [] });
        const s = seen.get(k);
        if (o.status === 'cancelled' || it.cancelled) continue;
        s.units += it.qty || 1; s.gross += (Number(it.price) || 0) * (it.qty || 1);
        s.firstSale = Math.min(s.firstSale, o.createdAt); s.lastSale = Math.max(s.lastSale, o.createdAt);
        if (it.price) s.prices.push(Number(it.price));
      }
    }
    res.json({
      settings: ledger.bo.settings, items: ledger.bo.items, catalog: ledger.bo.catalog,
      changelog: ledger.bo.changelog.slice(0, 500), seen: [...seen.values()].map((s) => ({ ...s, gross: Math.round(s.gross * 100) / 100, prices: undefined, lastPrice: s.prices.at(-1) || 0 })),
      snapshots: ledger.bo.snapshots.slice(-400), streams: ledger.streamList().map((s) => ({ id: s.id, startedAt: s.startedAt, endedAt: s.endedAt })),
      password: ledger.passwordSource(), lastImport: ledger.bo.lastImport || null,
    });
  });
  // Every order (compact) for the metrics dashboard + profitability (client-side).
  app.get('/api/bo/orders', requireAuth, requireBo, (_req, res) => {
    res.json({ orders: Object.values(ledger.orders).map((o) => ({
      id: o.id, createdAt: o.createdAt, buyerId: o.buyerId, buyer: o.buyer, buyerHandle: o.buyerHandle, status: o.status,
      channel: o.channel, streamId: o.streamId, total: o.total, fulfilledAt: o.fulfilledAt || null,
      items: (o.items || []).map((i) => ({ name: i.name, productId: i.productId, skuId: i.skuId, sku: i.sku, qty: i.qty, price: i.price, cancelled: i.cancelled, cs: i.cs })),
    })) });
  });
  app.post('/api/bo/terms', requireAuth, requireBo, (req, res) => {
    const b = req.body || {};
    if (!b.key) return res.status(400).json({ ok: false, error: 'missing item' });
    const r = ledger.setItemTerms(b.key, b.patch || {}, { label: b.label });
    if (b.patch && 'priority' in b.patch) queue.recomputePriority(); // ⭐ tick takes effect on the live queue now
    res.json({ ok: true, ...r });
  });
  app.post('/api/bo/settings', requireAuth, requireBo, (req, res) => res.json({ ok: true, ...ledger.setSettings(req.body || {}), settings: ledger.bo.settings }));
  app.post('/api/bo/sync', requireAuth, requireBo, async (_req, res) => {
    try {
      const r = await fetchCatalog();
      if (r.ok) ledger.setCatalog(r.products); else ledger.setCatalog(null, r.error);
      res.json({ ok: r.ok, error: r.error || '', needsScope: !!r.needsScope, count: r.ok ? r.products.length : 0 });
    } catch (e) { ledger.setCatalog(null, e.message); res.status(500).json({ ok: false, error: e.message }); }
  });
  // Price / stock edits: deliberate (pencil → value → Save), logged with before/after.
  const findSku = (pid, sid) => {
    const p = (ledger.bo.catalog.products || []).find((x) => x.id === String(pid));
    return p ? { p, s: (p.skus || []).find((x) => x.id === String(sid)) } : {};
  };
  app.post('/api/bo/price', requireAuth, requireBo, async (req, res) => {
    const { productId, skuId, price } = req.body || {};
    const { p, s } = findSku(productId, skuId);
    if (!s) return res.status(404).json({ ok: false, error: 'SKU not in the synced catalog — sync first.' });
    const r = await updateSkuPrice(productId, skuId, price);
    ledger.log({ kind: 'price', key: 'sku:' + skuId, label: `${p.title}${s.name ? ' — ' + s.name : ''}`, field: 'price', from: s.price, to: Number(price), result: r.ok ? 'ok' : 'failed: ' + r.error });
    if (r.ok) { s.price = Math.round(Number(price) * 100) / 100; ledger.saveBo(); }
    res.json(r);
  });
  app.post('/api/bo/stock', requireAuth, requireBo, async (req, res) => {
    const { productId, skuId, qty } = req.body || {};
    const { p, s } = findSku(productId, skuId);
    if (!s) return res.status(404).json({ ok: false, error: 'SKU not in the synced catalog — sync first.' });
    if ((s.warehouses || []).length > 1) return res.status(400).json({ ok: false, error: 'This SKU is stocked in more than one warehouse — change it in TikTok Seller Center.' });
    const wh = (s.warehouses || [])[0] && s.warehouses[0].id;
    const r = await updateSkuStock(productId, skuId, wh, qty);
    ledger.log({ kind: 'stock', key: 'sku:' + skuId, label: `${p.title}${s.name ? ' — ' + s.name : ''}`, field: 'stock', from: s.stock, to: Math.floor(Number(qty)), result: r.ok ? 'ok' : 'failed: ' + r.error });
    if (r.ok) { s.stock = Math.floor(Number(qty)); if (s.warehouses[0]) s.warehouses[0].qty = s.stock; ledger.saveBo(); }
    res.json(r);
  });
  // Import past TikTok orders into the ledger (for metrics history). Idempotent.
  let importing = null;
  app.post('/api/bo/import', requireAuth, requireBo, async (req, res) => {
    if (importing) return res.json({ ok: false, error: 'An import is already running.', progress: importing });
    const days = Math.max(1, Math.min(365, Number(req.body && req.body.days) || 90));
    const to = Date.now(); const from = to - days * 86400000;
    importing = { done: 0, total: 0, started: Date.now() };
    res.json({ ok: true, started: true, days });
    try {
      let added = 0, cancelled = 0, linked = 0, err = '';
      // Month-sized windows keep each search well inside TikTok's limits.
      for (let a = from; a < to; a += 30 * 86400000) {
        const b = Math.min(to, a + 30 * 86400000);
        const r = await fetchOrdersRange(a, b, (d, t) => { importing.done = d; importing.total = t; });
        if (!r.ok) { err = r.error; break; }
        for (const o of r.orders) {
          if (ledger.orders[String(o.id)]) { linked += ledger.backfillIds(o); continue; }
          const s = ledger.streamAt(o.createdAt);
          ledger.recordOrder(o, { channel: s ? 'live' : 'offline', streamId: s ? s.id : null, source: 'import' });
          if (/CANCEL/i.test(o.status || '')) { ledger.markCancelled(o.id, o.createdAt); cancelled++; }
          added++;
        }
      }
      ledger.bo.lastImport = { at: Date.now(), added, cancelled, linked, days, ...(err ? { error: err } : {}) };
      ledger.log({ kind: 'import', key: 'orders', label: 'TikTok order import', field: `last ${days} days`, from: null, to: `${added} orders added, ${linked} older lines linked to inventory` });
      ledger.flush(); ledger.saveBo();
    } catch (e) { ledger.bo.lastImport = { at: Date.now(), error: e.message, days }; ledger.saveBo(); }
    finally { importing = null; }
  });
  app.get('/api/bo/import', requireAuth, requireBo, (_req, res) => res.json({ running: importing, last: ledger.bo.lastImport || null }));
  app.get('/api/bo/export', requireAuth, requireBo, async (req, res) => {
    try {
      const q = req.query || {};
      const wb = await customExportWorkbook(ledger, {
        from: q.from ? Number(q.from) : 0, to: q.to ? Number(q.to) : Date.now() + 1,
        period: q.period, channel: q.channel, sheets: q.sheets ? String(q.sheets).split(',') : null,
      });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="LTs-sales-export-${new Date().toISOString().slice(0, 10)}.xlsx"`);
      await wb.xlsx.write(res); res.end();
    } catch (e) { console.error('[bo] export failed:', e); res.status(500).send('export failed: ' + e.message); }
  });
  app.get('/api/bo/changelog.csv', requireAuth, requireBo, (_req, res) => {
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['When (UTC)', 'Kind', 'Item / setting', 'Field', 'From', 'To', 'Result'].map(esc).join(',')];
    for (const c of ledger.bo.changelog) rows.push([new Date(c.ts).toISOString(), c.kind, c.label, c.field, c.from, c.to, c.result || ''].map(esc).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="LTs-backoffice-changelog.csv"');
    res.send('﻿' + rows.join('\r\n'));
  });

  // Background: keep the catalog fresh (daily stock snapshots power time-to-sell).
  // Quietly does nothing until the product scope is granted.
  const autoSync = async () => {
    try {
      const r = await fetchCatalog();
      if (r.ok) ledger.setCatalog(r.products);
      else if (!ledger.bo.catalog.syncedAt || productScopeHint(r.error)) ledger.setCatalog(null, r.error);
    } catch { /* offline / not authorised yet */ }
  };
  setTimeout(autoSync, 60000).unref?.();
  setInterval(autoSync, 6 * 3600 * 1000).unref?.();

  // Chat → panel sockets.
  chat.on('message', (m) => panelNs.emit('chat', m));
  chat.on('status', (s) => panelNs.emit('chat-status', s));
}

// Tiny, safe markdown → HTML for CHANGELOG.md (headings, bullets, bold, code).
function changelogPage(md, ADMIN) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  let html = ''; let depth = 0; // 0 = no list open, 1 = list, 2 = nested list
  const closeTo = (d) => { while (depth > d) { html += depth === 2 ? '</ul></li>' : '</li></ul>'; depth--; } };
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    const li = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (li) {
      const want = li[1].length >= 2 ? 2 : 1;
      if (want === 1) {
        if (depth === 0) { html += '<ul>'; depth = 1; } else { closeTo(1); html += '</li>'; }
        html += '<li>' + inline(li[2]);
      } else {
        if (depth === 0) { html += '<ul><li>'; depth = 1; }
        if (depth === 1) { html += '<ul>'; depth = 2; }
        html += '<li>' + inline(li[2]) + '</li>';
      }
      continue;
    }
    if (!line.trim()) continue;
    closeTo(0);
    if (m) html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
    else html += '<p>' + inline(line) + '</p>';
  }
  closeTo(0);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>What's new — LTs Workshop Queue</title>
<style>body{margin:0;background:#0f1115;color:#e8ebf2;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.55}
main{max-width:820px;margin:0 auto;padding:28px 20px 80px}a{color:#7fb0ff}h1{font-size:24px}h2{font-size:18px;margin-top:34px;padding-top:18px;border-top:1px solid #272c38}
h3{font-size:14px;color:#b9c2d6;text-transform:uppercase;letter-spacing:.6px;margin-top:20px}li{margin:4px 0}code{background:#1d212b;padding:1px 5px;border-radius:4px}p{color:#c7cede}</style></head>
<body><main><p><a href="${ADMIN}">← Back to the queue</a></p>${html}</main></body></html>`;
}

export { normName };
