// Excel builders for the after-action report and back-office exports.
// Every sheet: bold frozen header row, autofilter, sized columns, real currency /
// date formats (not text), so it opens clean in Excel / Numbers / Google Sheets.

import ExcelJS from 'exceljs';
import { buildFacts, aggregate, PERIODS, streamReport, tzParts, termsFromMap } from './analytics.js';

const MONEY = '"$"#,##0.00';
const PCT = '0.0"%"';
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const BAND_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };

// Excel has no time zones: write the store-local wall-clock time so a sale at
// 8:28 PM Eastern shows as 8:28 PM (not the UTC time).
const _wall = {};
function localDate(ms, tz) {
  if (!ms) return null;
  const f = _wall[tz] || (_wall[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second));
}

function fmtWhen(ms, tz) {
  if (!ms) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

/** Add a table sheet. cols = [{ header, key, width, fmt:'money'|'int'|'pct'|'date'|'text' }] */
function tableSheet(wb, name, cols, rows, opts = {}) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: opts.titleRows ? opts.titleRows + 1 : 1 }] });
  let r0 = 1;
  if (opts.title) {
    ws.getCell(1, 1).value = opts.title;
    ws.getCell(1, 1).font = { bold: true, size: 14 };
    if (opts.subtitle) { ws.getCell(2, 1).value = opts.subtitle; ws.getCell(2, 1).font = { color: { argb: 'FF6B7280' } }; }
    r0 = (opts.titleRows || 2) + 1;
  }
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width || 14 }));
  const hr = ws.getRow(r0);
  cols.forEach((c, i) => {
    const cell = hr.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = HEAD_FILL;
    cell.alignment = { vertical: 'middle', horizontal: c.fmt && c.fmt !== 'text' ? 'right' : 'left', wrapText: true };
  });
  hr.height = 22;
  rows.forEach((row, ri) => {
    const r = ws.getRow(r0 + 1 + ri);
    cols.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      let v = row[c.key];
      if (c.fmt === 'date' && v) v = localDate(v, opts.tz || 'America/New_York');
      cell.value = v === undefined ? null : v;
      if (c.fmt === 'money') cell.numFmt = MONEY;
      else if (c.fmt === 'int') cell.numFmt = '#,##0';
      else if (c.fmt === 'pct') cell.numFmt = PCT;
      else if (c.fmt === 'date') cell.numFmt = 'mmm d, yyyy h:mm AM/PM';
      if (c.wrap) cell.alignment = { wrapText: true, vertical: 'top' };
      if (row._band) cell.fill = BAND_FILL;
      if (row._bold) cell.font = { bold: true };
    });
  });
  if (rows.length) ws.autoFilter = { from: { row: r0, column: 1 }, to: { row: r0 + rows.length, column: cols.length } };
  return ws;
}

function kvSheet(wb, name, title, subtitle, sections) {
  const ws = wb.addWorksheet(name);
  ws.columns = [{ width: 38 }, { width: 18 }, { width: 50 }];
  ws.getCell('A1').value = title; ws.getCell('A1').font = { bold: true, size: 16 };
  ws.getCell('A2').value = subtitle; ws.getCell('A2').font = { color: { argb: 'FF6B7280' } };
  let r = 4;
  for (const sec of sections) {
    const h = ws.getCell(r, 1); h.value = sec.title; h.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    for (let c = 1; c <= 3; c++) ws.getCell(r, c).fill = HEAD_FILL;
    r++;
    for (const [label, value, fmt, note] of sec.rows) {
      ws.getCell(r, 1).value = label;
      const v = ws.getCell(r, 2); v.value = value;
      if (fmt === 'money') v.numFmt = MONEY; else if (fmt === 'pct') v.numFmt = PCT; else if (fmt === 'int') v.numFmt = '#,##0';
      v.alignment = { horizontal: 'right' };
      if (note) { ws.getCell(r, 3).value = note; ws.getCell(r, 3).font = { italic: true, color: { argb: 'FF6B7280' } }; }
      r++;
    }
    r++;
  }
  return ws;
}

export async function aarWorkbook(ledger, streamId) {
  const stream = ledger.streams[String(streamId)];
  if (!stream) return null;
  const settings = ledger.bo.settings;
  const termsOf = (l) => termsFromMap(ledger.bo.items, l);
  const rep = streamReport(stream, ledger.ordersForStream(streamId), settings, termsOf);
  const tz = settings.timezone;
  const t = rep.totals;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LTs Workshop Queue';
  const title = 'After-Action Report — ' + fmtWhen(rep.startedAt, tz);
  const sub = `${fmtWhen(rep.startedAt, tz)} → ${fmtWhen(rep.endedAt, tz)} (${tz})`;
  kvSheet(wb, 'Summary', title, sub, [
    { title: 'Sales', rows: [
      ['Orders', t.orders, 'int'], ['Unique buyers', t.buyers, 'int'], ['Units sold', t.units, 'int'],
      ['Gross sales', t.gross, 'money', 'What buyers paid for items (before shipping & tax)'],
      ['Average order', t.aov, 'money'], ['Cancelled orders', rep.cancelled.length, 'int'],
    ] },
    { title: 'Revenue (estimated)', rows: [
      ['TikTok fees', -t.tiktokFee, 'money', `${settings.tiktokFeePct}% of gross`],
      ['Streamer commission', -t.commission, 'money', `${settings.streamerPct}% of gross`],
      ['Shipping (estimate)', -t.shipping, 'money', settings.shippingMode === 'pct' ? `${settings.shippingPct}% of each order` : `$${settings.shippingFixed} per order`],
      ['Cost of goods (own stock)', -t.cogs, 'money', t.uncosted ? `$${t.uncosted.toFixed(2)} of sales have no cost entered yet` : ''],
      ['Consignee payouts', -t.payout, 'money'],
      ['Net revenue', t.net, 'money'], ['Net margin', t.margin, 'pct'],
    ] },
    { title: 'Own stock vs consignment', rows: [
      ['Own stock — gross', t.ownGross, 'money'], ['Own stock — net', t.ownNet, 'money'],
      ['Consignment — gross', t.consGross, 'money'], ['Consignment — paid to consignees', -t.consPayout, 'money'],
      ['Consignment — net to us', t.consNet, 'money'],
    ] },
  ]);
  const buyerRows = [];
  for (const b of rep.buyers) {
    b.orders.forEach((o, i) => buyerRows.push({
      buyer: i === 0 ? b.buyer : '', handle: i === 0 && b.handle ? '@' + b.handle : '',
      order: o.id, items: o.items.map((x) => `${x.qty}× ${x.name}${x.consigned ? ' (consigned)' : ''}`).join('\n'),
      orderTotal: o.total, spend: i === 0 ? b.spend : null, units: i === 0 ? b.units : null, _band: buyerRows.length % 2 === 1 && false,
    }));
  }
  tableSheet(wb, 'Buyers', [
    { header: 'Buyer', key: 'buyer', width: 26 }, { header: '@username', key: 'handle', width: 20 },
    { header: 'Order #', key: 'order', width: 22, fmt: 'text' }, { header: 'Items', key: 'items', width: 60, wrap: true },
    { header: 'Order total', key: 'orderTotal', width: 14, fmt: 'money' },
    { header: 'Buyer spend', key: 'spend', width: 14, fmt: 'money' }, { header: 'Buyer units', key: 'units', width: 12, fmt: 'int' },
  ], buyerRows);
  const facts = buildFacts(ledger.ordersForStream(streamId).filter((o) => o.status !== 'cancelled'), settings, termsOf);
  tableSheet(wb, 'Order lines', lineCols(), facts.map((f) => lineRow(f)), { tz });
  tableSheet(wb, 'Items', itemCols(), rep.items.map((x) => ({ ...x, name: x.key })));
  tableSheet(wb, 'Consignment', [
    { header: 'Consignee', key: 'key', width: 28 }, { header: 'Units', key: 'units', fmt: 'int' },
    { header: 'Gross', key: 'gross', fmt: 'money' }, { header: 'Paid to consignee', key: 'payout', fmt: 'money', width: 18 },
    { header: 'Net to us', key: 'net', fmt: 'money' }, { header: 'Margin %', key: 'margin', fmt: 'pct' },
  ], rep.consignees);
  if (rep.breaks.length) tableSheet(wb, 'Breaks', [
    { header: 'Break', key: 'title', width: 50 }, { header: 'Spots', key: 'spots', fmt: 'int' },
    { header: 'Buyers', key: 'buyers', fmt: 'int' }, { header: 'Value', key: 'value', fmt: 'money' }, { header: 'Status', key: 'status' },
  ], rep.breaks);
  if (rep.cancelled.length) tableSheet(wb, 'Cancelled', [
    { header: 'Order #', key: 'id', width: 22 }, { header: 'Buyer', key: 'buyer', width: 26 },
    { header: 'Items', key: 'items', width: 60, wrap: true }, { header: 'Total', key: 'total', fmt: 'money' },
  ], rep.cancelled.map((c) => ({ ...c, items: c.items.map((i) => `${i.qty}× ${i.name}`).join('\n') })));
  return { wb, rep };
}

function lineCols() {
  return [
    { header: 'Date', key: 'when', width: 20, fmt: 'date' }, { header: 'Channel', key: 'channel', width: 10 },
    { header: 'Order #', key: 'orderId', width: 22 }, { header: 'Buyer', key: 'buyer', width: 24 },
    { header: 'Item', key: 'name', width: 46 }, { header: 'SKU', key: 'sku', width: 16 },
    { header: 'Qty', key: 'qty', width: 7, fmt: 'int' }, { header: 'Unit price', key: 'unitPrice', fmt: 'money' },
    { header: 'Gross', key: 'gross', fmt: 'money' }, { header: 'TikTok fee', key: 'tiktokFee', fmt: 'money' },
    { header: 'Commission', key: 'commission', fmt: 'money' }, { header: 'Shipping est.', key: 'shipping', fmt: 'money' },
    { header: 'COGS', key: 'cogs', fmt: 'money' }, { header: 'Consignee payout', key: 'payout', fmt: 'money', width: 16 },
    { header: 'Net', key: 'net', fmt: 'money' }, { header: 'Consigned', key: 'consignedTxt', width: 10 },
    { header: 'Consignee', key: 'consignee', width: 18 }, { header: 'Price band', key: 'band', width: 12 },
  ];
}
function lineRow(f) { return { ...f, when: f.t, consignedTxt: f.consigned ? 'Yes' : '' }; }
function itemCols() {
  return [
    { header: 'Item', key: 'name', width: 50 }, { header: 'Units', key: 'units', fmt: 'int' }, { header: 'Orders', key: 'orders', fmt: 'int' },
    { header: 'Gross', key: 'gross', fmt: 'money' }, { header: 'Net', key: 'net', fmt: 'money' }, { header: 'Margin %', key: 'margin', fmt: 'pct' },
  ];
}

/** Custom back-office export. opts = { from, to, period, channel:'all'|'live'|'offline'|'split', sheets:[...] } */
export async function customExportWorkbook(ledger, opts = {}) {
  const settings = ledger.bo.settings;
  const tz = settings.timezone;
  const termsOf = (l) => termsFromMap(ledger.bo.items, l);
  const from = Number(opts.from) || 0;
  const to = Number(opts.to) || Date.now() + 1;
  const channel = ['live', 'offline', 'split'].includes(opts.channel) ? opts.channel : 'all';
  const period = PERIODS[opts.period] ? opts.period : 'month';
  let orders = Object.values(ledger.orders).filter((o) => o.createdAt >= from && o.createdAt < to);
  if (channel === 'live' || channel === 'offline') orders = orders.filter((o) => (o.channel || 'live') === channel);
  const facts = buildFacts(orders, settings, termsOf);
  const streamName = (id) => { const s = ledger.streams[id]; return s ? 'Stream ' + fmtWhen(s.startedAt, tz) : id; };
  const keyFn = (f) => {
    let k = PERIODS[period](f);
    if (period === 'stream' && f.streamId) k = streamName(f.streamId);
    return channel === 'split' ? `${k} · ${f.channel}` : k;
  };
  const rows = aggregate(facts, keyFn).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LTs Workshop Queue';
  const rangeTxt = `${from ? fmtWhen(from, tz) : 'All time'} → ${fmtWhen(Math.min(to, Date.now()), tz)} · ${channel === 'all' ? 'live + offline combined' : channel === 'split' ? 'live vs offline' : channel + ' only'} · by ${period}`;
  const sheets = new Set(opts.sheets && opts.sheets.length ? opts.sheets : ['summary', 'lines', 'items', 'buyers', 'consignment']);
  if (sheets.has('summary')) tableSheet(wb, 'Summary', [
    { header: period === 'stream' ? 'Stream' : 'Period', key: 'key', width: 30 },
    { header: 'Orders', key: 'orders', fmt: 'int', width: 9 }, { header: 'Buyers', key: 'buyers', fmt: 'int', width: 9 },
    { header: 'Units', key: 'units', fmt: 'int', width: 9 }, { header: 'Gross', key: 'gross', fmt: 'money' },
    { header: 'TikTok fees', key: 'tiktokFee', fmt: 'money' }, { header: 'Commission', key: 'commission', fmt: 'money' },
    { header: 'Shipping est.', key: 'shipping', fmt: 'money' }, { header: 'COGS', key: 'cogs', fmt: 'money' },
    { header: 'Consignee payouts', key: 'payout', fmt: 'money', width: 17 }, { header: 'Net', key: 'net', fmt: 'money' },
    { header: 'Margin %', key: 'margin', fmt: 'pct', width: 10 }, { header: 'Consigned gross', key: 'consGross', fmt: 'money', width: 16 },
    { header: 'Consigned net', key: 'consNet', fmt: 'money', width: 15 }, { header: 'Avg order', key: 'aov', fmt: 'money' },
  ], [...rows, { key: 'TOTAL', _bold: true, ...aggregate(facts, () => 'TOTAL')[0] }].filter((r) => r.orders != null),
  { title: 'Sales export', subtitle: rangeTxt });
  if (sheets.has('lines')) tableSheet(wb, 'Order lines', lineCols(), facts.map(lineRow), { tz });
  if (sheets.has('items')) tableSheet(wb, 'Items', itemCols(), aggregate(facts, (f) => f.name).sort((a, b) => b.gross - a.gross).map((x) => ({ ...x, name: x.key })));
  if (sheets.has('buyers')) tableSheet(wb, 'Buyers', [
    { header: 'Buyer', key: 'key', width: 30 }, { header: 'Orders', key: 'orders', fmt: 'int' }, { header: 'Units', key: 'units', fmt: 'int' },
    { header: 'Spend', key: 'gross', fmt: 'money' }, { header: 'Avg order', key: 'aov', fmt: 'money' },
  ], aggregate(facts, (f) => f.buyer).sort((a, b) => b.gross - a.gross));
  if (sheets.has('consignment')) tableSheet(wb, 'Consignment', [
    { header: 'Consignee', key: 'key', width: 28 }, { header: 'Units', key: 'units', fmt: 'int' },
    { header: 'Gross', key: 'gross', fmt: 'money' }, { header: 'Paid to consignee', key: 'payout', fmt: 'money', width: 18 },
    { header: 'Net to us', key: 'net', fmt: 'money' }, { header: 'Margin %', key: 'margin', fmt: 'pct' },
  ], aggregate(facts.filter((f) => f.consigned), (f) => f.consignee || 'Unnamed consignee'));
  return wb;
}

export function streamDayLabel(ms, tz) {
  const p = tzParts(ms, tz);
  return p.date;
}
