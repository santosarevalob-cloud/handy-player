// The Handy over API v3 with the Handy Streaming Protocol (HSP): stroke points go to the device ahead of
// time with timestamps, and it plays them on a clock synced to the Handy server. Classic script; defines
// globalThis.HandyDevice = {Device, Streamer}.
globalThis.HandyDevice = (() => {
  const API = 'https://www.handyfeeling.com/api/handy-rest/v3';

  class Device {
    constructor() {
      this.key = ''; this.appKey = ''; this.clockOffset = 0; this.connected = false;
      this.stats = {batches: 0, points: 0, rtt: 0};
      this.fetch = (url, init) => fetch(url, init);   // swappable: a page whose rules block the request can relay it
    }

    async api(method, path, body) {
      const t0 = performance.now();
      const r = await this.fetch(API + path, {
        method,
        headers: {'X-Connection-Key': this.key, 'X-Api-Key': this.appKey, 'Content-Type': 'application/json'},
        body: body && JSON.stringify(body),
      });
      this.stats.rtt = Math.round(performance.now() - t0);
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error?.message || (
        r.status === 401 || r.status === 403 ? 'the Application ID was not accepted' :
        r.status === 429 ? 'too many requests for the Handy server' : `the Handy server answered ${r.status}`));
      return data.result ?? data;
    }

    serverNow() { return Math.round(Date.now() + this.clockOffset); }

    // Browser-to-server clock offset, measured the way Handy's own example client does it. Returns the round trip.
    async syncClock(samples = 8) {
      const s = [];
      for (let i = 0; i < samples; i++) {
        const t0 = Date.now(), r = await this.api('GET', '/servertime'), t1 = Date.now();
        s.push({rtd: t1 - t0, offset: r.server_time + (t1 - t0) / 2 - t1});
      }
      s.sort((a, b) => a.rtd - b.rtd).splice(-2);   // drop the slowest samples
      this.clockOffset = s.reduce((a, c) => a + c.offset, 0) / s.length;
      return s.reduce((a, c) => a + c.rtd, 0) / s.length;
    }

    // Checks the device is online and syncs clocks. Resolves to a suggested lag (ms) for the picture hold-back.
    async connect(key, appKey) {
      if (!/^[a-zA-Z0-9]{5,64}$/.test(key)) throw new Error('that connection key does not look right. It is the short code shown in the Handy app');
      if (!appKey) throw new Error('an Application ID is needed too: sign in at user.handyfeeling.com, open Application IDs and generate one');
      this.key = key; this.appKey = appKey; this.connected = false;
      if ((await this.api('GET', '/connected')).connected === false) throw new Error('the Handy is offline. Check it is switched on and connected to Wi-Fi');
      const net = await this.syncClock();
      const dev = await this.api('GET', '/hstp/clocksync').catch(() => ({}));   // also makes the device sync its clock
      const rtd = Number(dev.rtd ?? dev.result?.rtd) || 200;
      this.connected = true;
      return Math.min(600, Math.round((net + rtd) / 20) * 10);
    }

    setup() { return this.api('PUT', '/hsp/setup', {stream_id: Math.floor(Math.random() * 1e9) + 1}); }
    play(startTime, firstPoints) {
      return this.api('PUT', '/hsp/play', {start_time: Math.round(startTime), server_time: this.serverNow(), pause_on_starving: false, add: firstPoints});
    }
    add(points, tail) { this.stats.batches++; this.stats.points += points.length; return this.api('PUT', '/hsp/add', {points, tail_point_stream_index: tail}); }
    syncTime(current) { return this.api('PUT', '/hsp/synctime', {current_time: Math.round(current), server_time: this.serverNow(), filter: 0.5}); }
    pause() { return this.api('PUT', '/hsp/pause'); }
    resume() { return this.api('PUT', '/hsp/resume'); }
    stop() { return this.api('PUT', '/hsp/stop'); }
  }

  // Feeds tracker points to a Device: maps 0..1 to the stroke range, caps speed, batches every 300 ms,
  // and keeps the device clock on the playhead. Times are "stream ms": whatever clock the caller's
  // points use (video time, or a page clock), which `playhead()` must return in the same unit.
  // `source()` returns the points produced since the last call; it is polled on the batch timer.
  class Streamer {
    constructor(device, {range, playhead, source, onError}) {
      this.device = device; this.range = range; this.playhead = playhead; this.source = source; this.onError = onError || (() => {});
      this.running = false; this.pending = []; this.streamed = 0; this.lastX = -1; this.lastXt = -Infinity;
      this.timer = null; this.syncTimer = null;
    }

    toDevice(v) {
      const {lo, hi, invert} = this.range();
      return lo + (invert ? 1 - v : v) * (hi - lo);
    }

    async start(firstPoints) {
      this.stopTimers();
      this.pending = []; this.streamed = 0; this.lastX = -1; this.lastXt = -Infinity;
      await this.device.setup();
      const first = firstPoints && this.prepare(firstPoints);
      if (first) this.streamed = first.length;
      await this.device.play(this.playhead(), first ? {points: first.slice(0, 100), tail_point_stream_index: Math.min(100, first.length)} : undefined);
      if (first && first.length > 100) { this.streamed = 100; await this.send(first.slice(100)); }
      this.running = true;
      this.timer = setInterval(() => this.flush(), 300);
      // Nudge the device clock onto the playhead: every 2 s at first, then every 10 s, as Handy's docs suggest.
      let n = 0;
      this.syncTimer = setInterval(() => { if (++n <= 5 || n % 5 === 0) this.sync(); }, 2000);
    }

    // Points in stream ms with v 0..1 → device points {t, x}, speed-capped and in order.
    prepare(points) {
      const out = [], {speedMs} = this.range(), head = this.playhead();
      for (const p of points) {
        const t = Math.round(p.t);
        if (t <= this.lastXt || t < head) continue;   // out of order, or already in the past
        let x = this.toDevice(p.v);
        // The slide has a top speed. A move it cannot finish in time is shortened, not slowed, so the beat stays right.
        const reach = (t - this.lastXt) / speedMs * 100;
        if (this.lastX >= 0) x = this.lastX + Math.max(-reach, Math.min(reach, x - this.lastX));
        x = Math.round(x); this.lastX = x; this.lastXt = t;
        out.push({t, x});
      }
      return out.length ? out : null;
    }

    // The device takes at most 100 points per add.
    async send(points) {
      for (let i = 0; i < points.length; i += 100) {
        const chunk = points.slice(i, i + 100);
        this.streamed += chunk.length;
        await this.device.add(chunk, this.streamed);
      }
    }

    push(points) { if (this.running) this.pending.push(...points); }

    flush() {
      if (this.source) this.pending.push(...this.source());
      // A slow reply must not let the next batch overtake it: the device needs the adds in order.
      if (!this.pending.length || this.busy) return;
      const batch = this.prepare(this.pending);
      this.pending = [];
      if (!batch) return;
      this.busy = true;
      this.send(batch).catch(e => { this.stop(); this.onError(e); }).finally(() => { this.busy = false; });
    }

    sync() { if (this.running) this.device.syncTime(this.playhead()).catch(() => {}); }

    // The playhead jumped (seek): drop everything queued and restart at the new position.
    async seek() {
      if (!this.running) return;
      await this.start();
    }

    async pause() { if (this.running) await this.device.pause().catch(() => {}); }
    async resume() { if (this.running) { await this.device.resume().catch(() => {}); this.sync(); } }

    stopTimers() { clearInterval(this.timer); clearInterval(this.syncTimer); this.timer = this.syncTimer = null; }

    stop() {
      this.stopTimers();
      if (this.running) this.device.stop().catch(() => {});
      this.running = false; this.pending = [];
    }
  }

  return {Device, Streamer, API};
})();
