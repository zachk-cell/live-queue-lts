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

const MAX_BUFFER = 300;

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
          handle: String(d?.user?.uniqueId || ''),
          nickname: String(d?.user?.nickname || ''),
          userId: d?.user?.userId ? String(d.user.userId) : '',
          text: String(d?.comment || d?.content || ''),
        };
        if (!msg.text) return;
        this.buffer.push(msg);
        if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
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
