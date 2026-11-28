# What's new — LTs Workshop Queue

Every update to the queue is listed here, newest first: what changed and what it means for you.

## November 28, 2026 (late morning) — Reports moved into the back office
- **After-action reports now live in 🔒 Back office → 📋 Reports** and need the back-office password, because they include sales, revenue and TikTok payouts.
- **The panel header has 📦 Shipping instead of 📋 Reports.** It lists every stream's money-free packing list and needs no extra password, so the shipping team can use it.
- The between-streams box on the panel links to both the full report and the shipping report.

## November 28, 2026 (morning) — Real numbers from TikTok, shipping report, chat archive
- **Sales are counted before coupons.** A spot bought with a TikTok coupon now counts at its full price (e.g. $84.99), with "paid $0.01 · coupon $84.98" shown under it. TikTok pays those coupons back, so they no longer make sales look smaller. Seller-funded discounts are shown separately and do come off revenue. Older orders were updated from TikTok automatically.
- **TikTok actuals:**
  - the queue now pulls TikTok's real settlement for every order: revenue, fees, shipping label cost, refunds and the amount actually paid out
  - reports and Sales metrics show them next to the estimates, e.g. "fees 6.9% actual vs 6% estimate"
  - orders settle about a week after delivery, so recent streams fill in over time
  - it runs every 4 hours, or on demand from ⚙ Settings → Sync settlements & refunds
- **Refunds, disputes & cancellations:**
  - refund-request %, refunded % and $, disputes (and how many TikTok decided for LTs) and cancellation % split by buyer / seller / system, plus top refund reasons
  - orders show REFUND REQ / REFUNDED tags
- **📦 Shipping report:** a money-free version of each after-action report for the shipping team. Buyers A–Z, order numbers, items, quantities, a tick box per order, items to pull, refund flags and the do-not-ship list. It's a link at the top of every report, and it prints to PDF.
- **💬 Chat archive:** End Live now saves that stream's chat with its report (searchable via 💬 Chat log) and clears the chat box for the next stream. Last night's chat was filed under its stream automatically.

## November 28, 2026 — Chat fixed, searchable and redesigned
- **Chat now connects and reads the feed.** Three fixes: the account name is read in lowercase (TikTok's lookup is case-sensitive), messages are read from the field the new chat reader uses, and the sender's @handle is read correctly so #1-buyer matching works.
- **🔍 Search the chat:** search the whole stream's chat by words, display name or @handle, with matches highlighted. Click anyone's name to see all of their messages. The chat is kept on the server (several thousand messages), so a restart mid-stream doesn't lose it.
- **Cleaner layout:**
  - **#1 buyer / All chat** tabs that stay in place for quick switching
  - each message shows a colored name, @handle and time, with the #1 buyer marked
  - a **↓ New messages** button when you've scrolled up
- **⚙ Chat settings** now holds the LIVE account and ↻ Reconnect, out of the way.

## November 27, 2026 (late night) — Reused listings counted correctly
- **Reused listings are now handled.** TikTok keeps a listing's ID when it's re-titled for a different item. The back office now spots sales made under a clearly different name and counts them as their own item.
- **Dragon Frontiers DADDY BREAK (100 Spot):** its listing was previously the “Legendary Collection Galaxy Rips Galactic Gooner Bag” (924 units sold Nov 14). Those sales are now their own item, so the break shows only its own sales. Its time to sell is measured from when the listing was reused, not its original listing date.
- Small title edits to the same item are left alone, and every split is logged in the Changelog. Nothing is deleted: totals, reports and the Gooner Bag's own history are unchanged.

## November 27, 2026 (night) — Tidier inventory list
- **Deactivated and Deleted listings** now sit in their own collapsed sections at the bottom of Inventory & pricing. Click a section to open it.
- **Sort by Price or Stock:** click the column header for high → low, click again for low → high, and a third time to clear.
- **No more jumping to the top:** ticking ⭐ or 🎯, editing a value, or sorting keeps your place in the list.

## November 27, 2026 (evening) — 🎯 Break toggle
- **You choose which items are breaks.** In Back office → Inventory & pricing, the new **🎯 Break** column marks a listing as a break. When it sells, its spots open their own break section, with the spot total read from the name (e.g. “(33 Spot)”).
- **A name with “break” in it no longer opens a break by itself**, so *Box Break* packs stay normal (priority) queue items.
- Your current DADDY BREAK listings are already toggled on. New break listings need 🎯 switched on before they sell. ⚙ Break settings in the queue lists every toggled item.

## November 27, 2026 (afternoon) — Product access is live
- The LTs shop re-authorized the app, and every permission the back office needs is now granted, including Product (price and stock editing).
- **Inventory synced:** 68 listings with live prices and stock. Today's stock snapshot is saved, so time-to-sell starts counting from here.
- **Order import now links older sales to inventory.** Orders saved before TikTok ids were captured get their product and SKU ids filled in, so ⭐ priority, cost and the per-item metrics cover your full history. Money, status and stream credit are never changed.

## November 27, 2026 (overnight) — Lighter offline checking
- While offline, the queue now checks TikTok for new orders **every 5 minutes** instead of every 30 seconds, which cuts background traffic.
- **Nothing is missed:** offline orders just appear up to 5 minutes later.
- Going live still pulls the last 15 minutes of orders straight into the queue.
- While live, it still checks every 10 seconds.

## November 27, 2026 (late night) — Smarter #1 buyer chat matching
- The chat box matches the #1 buyer by **display name or @username**, ignoring emoji, accents, spacing and capitals.
- Once a buyer's display name matches, it **remembers their @username**, so their later messages still match.
- It still follows whoever is #1 automatically. The only one-time setting is the LTs streaming account's @handle, so it knows which LIVE to read.

## November 27, 2026 (night) — Tidier offline orders, ⭐ priority ticks
- **🌙 Offline orders moved** below "Fulfilled this stream". Each order is now one line (buyer, item count, first item, total) and **clicking it expands** the full item list, so nothing wraps.
- **The after-action report banner hides as soon as you Go Live**, so it's out of the way during the stream. Every past report is always under **📋 Reports** in the header.
- **⭐ Priority tick:** in Back office → Inventory & pricing, tick ⭐ next to any item and every order containing it becomes PRIORITY in the live queue. It's matched to the exact TikTok item, so no keyword matching is needed.
- Keywords still work alongside, or you can leave them empty. The ⭐ Priority items window lists the ticked items, and every tick is logged in the Changelog.

## November 27, 2026 (evening) — TikTok permissions check
- **Back office → Settings → Check TikTok permissions.** Shows which API permissions the LTs shop granted the app, and proves each with a harmless read: orders, products, price/stock editing, plus optional finance, shipping and returns. It never changes anything.

## November 27, 2026 (later) — Fix: past-stream reports
- Break orders that carried over from one stream to the next were counted in the **later** stream's imported report. Each order is now credited to the stream it was **placed** in, keeping its latest status. Past reports were corrected automatically.

## November 27, 2026 — Offline orders, seat labels, reports, back office & metrics

### Orders are never missed now
- **Always listening.** While you're offline the queue still checks TikTok for new orders (now every 5 minutes). Break spots go straight into their break (a break opens automatically if needed), and everything else lands in the new **🌙 Offline orders** section.
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
