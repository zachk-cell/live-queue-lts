// Read-only TikTok LIVE chat feed for the admin panel.
//
// Uses the UNOFFICIAL tiktok-live-connector (reverse-engineered, no login, read
// only — it never posts). TikTok's official Shop API has no chat access. If the
// library breaks (TikTok changes its protocol) the panel simply shows "chat
// disconnected"; nothing else in the queue depends on it.
//
// The panel filters this feed down to messages from whoever is #1 in the queue,
// so in a busy chat the person being ripped is easy to spot.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

// Kept in memory (and on disk, so a restart mid-stream doesn't lose it) for the
// panel's chat search. ~5000 messages is several hours of a busy LIVE.
const MAX_BUFFER = 5000;
const BUFFER_FILE = path.resolve(process.cwd(), 'data', 'chat-buffer.json');

export class LiveChat extends EventEmitter {
  constructor(getUsername) {
    super();
    this.getUsername = getUsername; // () => '@handle' (setting or env)
    this.conn = null;
    this.state = 'off';            // off | connecting | connected | offline | error
    this.error = '';
    this.username = '';
    this.buffer = [];
    this._retry = null;
    this._want = false;
    this._saveT = null;
    try { const j = JSON.parse(fs.readFileSync(BUFFER_FILE, 'utf8')); if (Array.isArray(j)) this.buffer = j.slice(-MAX_BUFFER); } catch { /* none yet */ }
  }

  _save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(BUFFER_FILE), { recursive: true });
        fs.writeFileSync(BUFFER_FILE + '.tmp', JSON.stringify(this.buffer));
        fs.renameSync(BUFFER_FILE + '.tmp', BUFFER_FILE);
      } catch (e) { console.warn('[chat] save failed:', e.message); }
    }, 5000);
    this._saveT.unref?.();
  }

  /** Search the kept chat: every word must appear in the message, display name
   *  or @handle (case/accent-insensitive). Newest last, up to `limit`. */
  search(q, limit = 300) {
    const norm = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const words = norm(q).replace(/^@/, '').split(/\s+/).filter(Boolean);
    if (!words.length) return { total: 0, messages: [] };
    const hits = this.buffer.filter((m) => { const h = norm(`${m.text} ${m.nickname} ${m.handle} @${m.handle}`); return words.every((w) => h.includes(w)); });
    return { total: hits.length, messages: hits.slice(-limit) };
  }

  status() {
    return { state: this.state, error: this.error, username: this.username, count: this.buffer.length, feed: this.feed || null };
  }
  recent(n = 150) { return this.buffer.slice(-n); }

  _set(state, error = '') {
    this.state = state; this.error = error;
    this.emit('status', this.status());
  }

  async start() {
    this._want = true;
    // TikTok handles are lowercase; the lookup API answers user_not_found for "LTsworkshop".
    const u = String(this.getUsername() || '').replace(/^@/, '').trim().toLowerCase();
    if (!u) { this._set('off', 'Set the TikTok @username to turn chat on'); return; }
    if (this.conn && this.username === u && (this.state === 'connected' || this.state === 'connecting')) return;
    await this.stop(true);
    this._want = true;
    this.username = u;
    this._set('connecting');
    let lib;
    try { lib = await import('tiktok-live-connector'); }
    catch (e) { this._set('error', 'chat library not installed: ' + e.message); return; }
    try {
      const { TikTokLiveConnection, WebcastEvent, ControlEvent } = lib;
      const conn = new TikTokLiveConnection(u, { processInitialData: false, enableExtendedGiftInfo: false });
      this.conn = conn;
      // Feed health (shown in /api/chat): proves whether TikTok is sending anything.
      this.feed = { frames: 0, decoded: 0, chats: 0, kinds: {}, lastAt: null, chatKeys: null };
      conn.on(ControlEvent.WEBSOCKET_DATA, () => { this.feed.frames++; this.feed.lastAt = Date.now(); });
      conn.on(ControlEvent.DECODED_DATA, (type) => { this.feed.decoded++; const k = String(type || '?').slice(0, 40); this.feed.kinds[k] = (this.feed.kinds[k] || 0) + 1; });
      conn.on(WebcastEvent.CHAT, (d) => {
        this.feed.chats++; if (!this.feed.chatKeys) this.feed.chatKeys = Object.keys(d || {}).slice(0, 20);
        const msg = {
          id: d?.common?.msgId ? String(d.common.msgId) : `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          at: Date.now(),
          // Connector v2.5 (proto v3): @handle is user.displayId, id is user.id.
          handle: String(d?.user?.uniqueId || d?.user?.displayId || ''),
          nickname: String(d?.user?.nickname || ''),
          userId: String(d?.user?.userId || d?.user?.id || ''),
          text: String(d?.comment || d?.content || ''),
        };
        if (!msg.text) return;
        this.buffer.push(msg);
        if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
        this._save();
        this.emit('message', msg);
      });
      conn.on(ControlEvent.DISCONNECTED, () => { this._set('offline', 'disconnected'); this._scheduleRetry(); });
      conn.on(ControlEvent.ERROR, (e) => { this.error = String(e?.message || e || 'error'); });
      await conn.connect();
      this._set('connected');
    } catch (e) {
      let m = String(e?.message || e || 'could not connect');
      // "Failed to retrieve Room ID from all sources" hides the real reasons —
      // surface each source's error so the panel/log says what TikTok returned.
      const inner = (e?.config?.requestErrs || e?.requestErrs || []).map((x) => String(x?.message || x).replace(/\s+/g, ' ').slice(0, 160));
      if (inner.length) m += ' — ' + inner.join(' | ');
      console.warn('[chat] connect failed for @' + u + ':', m);
      this._set(/offline|not live|UserOffline|isn't online|not online/i.test(m) ? 'offline' : 'error', m.slice(0, 600));
      this._scheduleRetry();
    }
  }

  _scheduleRetry() {
    clearTimeout(this._retry);
    if (!this._want) return;
    this._retry = setTimeout(() => { if (this._want) this.start().catch(() => {}); }, 30000);
    this._retry.unref?.();
  }

  async stop(silent = false) {
    this._want = false;
    clearTimeout(this._retry);
    const c = this.conn; this.conn = null;
    if (c) { try { await c.disconnect(); } catch { /* ignore */ } }
    if (!silent) this._set('off');
  }
}
