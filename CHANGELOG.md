# What's new — LTs Workshop Queue

Every update to the queue is listed here, newest first: what changed and what it means for you.

## November 27, 2026 (evening) — TikTok permissions check
- **Back office → Settings → Check TikTok permissions.** Shows which API permissions the LTs shop granted the app, and proves each with a harmless read: orders, products, price/stock editing, plus optional finance, shipping and returns. It never changes anything.

## November 27, 2026 (later) — Fix: past-stream reports
- Break orders that carried over from one stream to the next were counted in the **later** stream's imported report. Each order is now credited to the stream it was **placed** in, keeping its latest status. Past reports were corrected automatically.

## November 27, 2026 — Offline orders, seat labels, reports, back office & metrics

### Orders are never missed now
- **Always listening.** While you're offline the queue still checks TikTok every 30 seconds. Break spots go straight into their break (a break opens automatically if needed), and everything else lands in the new **🌙 Offline orders** section.
- **Offline orders section.** Grouped by day. Select orders, print a label for each (flagged **OFFLINE ORDER**), and mark them handled. Undo stays available for 7 days.
- **Go Live picks up the last 15 minutes.** Any unhandled offline order from the 15 minutes before Go Live moves into the live queue, same as the old pre-live backfill.
- **No double-counting.** A live order seen again after End Live is never re-added as an offline order.

### Break labels: one per seat, plus one shipping label per order
- Every seat prints its own label: **SEAT 1 OF 3**, **SEAT 2 OF 3**, and so on, with the round and spot number.
- Every order number gets one extra **SHIPPING LABEL** with the buyer's name, the order number, and how many items are in the order.
- **Labels = seats + orders.** If an order runs across two rounds, its shipping label prints with the round holding its last seat. The buttons show the exact count before you print.

### After-action reports
- Ending a live builds the stream's report and offers to open it straight away.
- Each report covers:
  - every unique buyer, with their order numbers, items and spend
  - items sold and sales by hour
  - breaks and cancellations
  - gross sales, and estimated net revenue after TikTok fees, streamer commission, shipping, cost of goods and consignee payouts
- **Consignment is shown separately:** gross, paid to consignees, and net to us, with a per-consignee table.
- Open reports from the **📋 View prior stream after-action report** box, or **📋 Reports** for every past stream.
- **Export:** a formatted **Excel** workbook, or **PDF** (print → Save as PDF).

### 🔒 Back office (its own password)
- **Inventory & pricing:**
  - price, stock, your cost, consignment terms, units sold and net per unit for every item
  - price and stock edits update the **live TikTok listing**, and always go ✎ → value → Save → confirm
- **Consignment:**
  - mark items, or every variant of a product, as consigned; name the consignee and set their share (% of sale or fixed $ per unit)
  - terms are stamped on each sale, so changing them later never rewrites past payouts
- **Profit & exports:**
  - any range, live / offline / combined / side by side, grouped by stream, day, week, month, quarter or year
  - downloads as a formatted Excel workbook
- **Sales metrics:**
  - best days and hours, with a day × hour heat map, and sales by month
  - top spenders and best sellers
  - price points, and time to sell by item and price range
  - consignment profitability and time to sell
  - live vs offline
- **Changelog:** every cost, consignment, price, stock and setting change, with before and after values. Downloadable as CSV.
- **Settings:**
  - TikTok fee 6%, streamer commission 10%, shipping estimate (fixed $8 per order, or a % of the order)
  - report time zone and the password
  - one-click import of past TikTok orders
- **Waiting on the streamer:** live stock and price editing need the TikTok **Product** permission. Until it's added, the back office shows "waiting for product access", and costs, consignment, reports and metrics all work.

### 💬 #1 buyer chat
- A small chat box shows only messages from **whoever is #1 in the queue**. **Show all chat** switches to the full feed.
- It's read-only and connects on Go Live. Set the stream's TikTok @username once.
- It uses an unofficial chat reader, because TikTok's shop API has no chat access. If it ever disconnects, nothing else is affected.

### Behind the scenes
- **Permanent sales history.** Every order, live or offline, is kept forever on the server's persistent disk. Past streams were imported automatically.
- **TikTok ids recorded.** Order lines now keep their TikTok product and SKU ids, so sales link to inventory, cost and consignment.
- **Guide updated.** The operator guide now covers breaks, offline orders, chat, reports and the back office.

## November 25, 2026 — Breaks keep going
- Offline listening for open breaks.
- Open breaks with spots left carry over when the live ends.
- Restore unfinished breaks from a past stream.
- Rounds hold exactly N spots; overflow orders split into the next round.
- Fulfil spots singly, by selection or by round.
- Read-only TikTok order audit to find missing orders.

## November 24, 2026 — Breaks
- Break items go to their own section instead of the queue, and split orders are flagged.
- Entries are numbered in rip order (no combining).
- Editable total spots.
- Individual and batch break labels.

## November 2, 2026 — Labels & exports
- Multi-select and batch label printing.
- Label layout: centered display name and last-5 order number.
- SKU sales export (quantity and dollar volume per SKU).

## October 31, 2026 — Launch
- LTs Workshop Queue launched, with staggered priority.
