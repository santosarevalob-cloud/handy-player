// Motion tracker: turns video frames into stroke points. No DOM beyond one scratch canvas.
// Classic script so content scripts and plain pages can load it; defines globalThis.HandyTracker.
globalThis.HandyTracker = (() => {
  const N = 48, MAX = 8;   // tracker grid size, and the largest per-frame shift it searches (grid px)
  const G = 32;            // grid for the "where is the motion" map

  // How far the picture moved between two n×n grayscale frames, as pixels.
  // Only pixels that changed are compared, so a still background does not vote for "no motion".
  function estimateShift(prev, cur, n, max = MAX, cx = 0, cy = 0) {
    const moving = [];
    for (let i = 0; i < cur.length; i++) if (Math.abs(cur[i] - prev[i]) > 12) moving.push(i);
    if (moving.length < cur.length * 0.02) return {dx: 0, dy: 0, err: 0, weak: false};
    const side = 2 * max + 1, err = new Float32Array(side * side);
    for (let dy = -max; dy <= max; dy++) for (let dx = -max; dx <= max; dx++) {
      let sum = 0, cnt = 0;
      for (const i of moving) {
        const x = i % n - dx - cx, y = (i / n | 0) - dy - cy;
        if (x >= 0 && x < n && y >= 0 && y < n) { sum += Math.abs(cur[i] - prev[y * n + x]); cnt++; }
      }
      err[(dy + max) * side + dx + max] = cnt > moving.length / 2 ? sum / cnt : Infinity;
    }
    let best = max * side + max;   // start at the centre so ties mean "no further motion"
    for (let k = 0; k < err.length; k++) if (err[k] < err[best]) best = k;
    const bx = best % side, by = best / side | 0;
    const sub = (a, b, c) => { const d = a - 2 * b + c; return d > 0 && isFinite(d) ? 0.5 * (a - c) / d : 0; };
    // A match on the search boundary, or one barely better than "no motion", means the real shift may be further out.
    const weak = bx === 0 || bx === side - 1 || by === 0 || by === side - 1 || err[best] > 0.7 * err[max * side + max];
    return {
      dx: cx + bx - max + (bx > 0 && bx < side - 1 ? sub(err[best - 1], err[best], err[best + 1]) : 0),
      dy: cy + by - max + (by > 0 && by < side - 1 ? sub(err[best - side], err[best], err[best + side]) : 0),
      err: err[best], weak,
    };
  }

  // Fast strokes move more than MAX px between frames. When the full-size search ends on its own
  // boundary, the motion is probably beyond it: search a half-size copy (reaches ±2·MAX), then refine.
  function half(img, n) {
    const m = n / 2, out = new Uint8Array(m * m);
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      const i = 2 * y * n + 2 * x;
      out[y * m + x] = (img[i] + img[i + 1] + img[i + n] + img[i + n + 1]) >> 2;
    }
    return out;
  }
  function flow(prev, cur) {
    let best = estimateShift(prev, cur, N, MAX);
    if (best.weak) {
      const c = estimateShift(half(prev, N), half(cur, N), N / 2, MAX);
      const far = estimateShift(prev, cur, N, 2, Math.round(c.dx * 2), Math.round(c.dy * 2));
      if (far.err < best.err) best = far;
    }
    return [best.dx, best.dy];
  }

  class Tracker {
    constructor({maxSeg = 400} = {}) {
      this.maxSeg = maxSeg;            // ms: longest gap between stroke points
      this.roi = {x: .3, y: .1, w: .4, h: .8};
      this.auto = true;
      this.energy = new Float32Array(G * G);
      this.points = [];                // {t, v}: stroke points, v from 0 (bottom) to 1 (top)
      this.sentIdx = 0;                // points before this index were handed on and must not change
      this.log = null;                 // set to an array to record per-frame numbers
      this.onRoi = null;               // called when the box moves
      const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(N, N) : Object.assign(document.createElement('canvas'), {width: N, height: N});
      this.scratch = c.getContext('2d', {willReadFrequently: true});
      this.reset();
    }

    reset() {
      this.prev = this.prevFull = null; this.frameNo = 0;
      this.sxx = 0; this.sxy = 0; this.syy = 1e-6; this.pos = 0; this.lastT = 0;
      this.samples = []; this.dir = 1; this.cand = null;
      this.energy.fill(0);
    }

    setRoi(roi, manual = true) {
      this.roi = roi; this.prev = null;
      if (manual) this.auto = false;
      this.onRoi?.(roi);
    }

    gray(source, sw, sh, x, y, w, h, n) {
      const s = this.scratch;
      s.drawImage(source, x * sw, y * sh, w * sw, h * sh, 0, 0, n, n);
      const px = s.getImageData(0, 0, n, n).data, out = new Uint8Array(n * n);
      for (let i = 0; i < out.length; i++) out[i] = (px[i * 4] * 2 + px[i * 4 + 1] * 5 + px[i * 4 + 2]) >> 3;
      return out;
    }

    // One frame. `source` is a video or canvas of size sw×sh, `t` the stroke-time of the frame in ms.
    feed(source, sw, sh, t) {
      const full = this.gray(source, sw, sh, 0, 0, 1, 1, G), e = this.energy;
      if (this.prevFull) for (let i = 0; i < full.length; i++) e[i] = e[i] * .96 + Math.abs(full[i] - this.prevFull[i]);
      this.prevFull = full;
      if (this.auto && ++this.frameNo % 30 === 0) this.autoRoi();
      const r = this.roi, cur = this.gray(source, sw, sh, r.x, r.y, r.w, r.h, N);
      if (this.prev) this.track(...flow(this.prev, cur), t);
      this.prev = cur;
    }

    // Move the box to where the picture has been changing most over the last few seconds.
    autoRoi() {
      const e = this.energy;
      let max = 0;
      for (const v of e) max = Math.max(max, v);
      if (max < 50) return;
      const w = i => Math.max(0, e[i] - max * .25);
      let sw = 0, mx = 0, my = 0, vx = 0, vy = 0;
      for (let i = 0; i < e.length; i++) { sw += w(i); mx += w(i) * (i % G + .5); my += w(i) * ((i / G | 0) + .5); }
      mx /= sw; my /= sw;
      for (let i = 0; i < e.length; i++) { vx += w(i) * (i % G + .5 - mx) ** 2; vy += w(i) * ((i / G | 0) + .5 - my) ** 2; }
      const hw = Math.max(.1, 2.2 * Math.sqrt(vx / sw) / G), hh = Math.max(.1, 2.2 * Math.sqrt(vy / sw) / G);
      const x0 = Math.max(0, mx / G - hw), y0 = Math.max(0, my / G - hh);
      const x1 = Math.min(1, mx / G + hw), y1 = Math.min(1, my / G + hh);
      const r = this.roi;
      const moved = Math.max(Math.abs(x0 - r.x), Math.abs(y0 - r.y), Math.abs(x1 - r.x - r.w), Math.abs(y1 - r.y - r.h));
      if (moved > .08) this.setRoi({x: x0, y: y0, w: x1 - x0, h: y1 - y0}, false);
    }

    // The part of the picture that has changed at all since it started: the player, on a page that includes more.
    motionBounds() {
      const e = this.energy;
      let max = 0;
      for (const v of e) max = Math.max(max, v);
      if (max < 20) return null;
      let x0 = G, y0 = G, x1 = -1, y1 = -1;
      for (let i = 0; i < e.length; i++) if (e[i] > max * .02) {
        const x = i % G, y = i / G | 0;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      return {x: x0 / G, y: y0 / G, w: (x1 + 1 - x0) / G, h: (y1 + 1 - y0) / G};
    }

    addPoint(t, v) {
      v = Math.min(1, Math.max(0, v));
      const pts = this.points, last = pts[pts.length - 1];
      if (last && t <= last.t) return;
      // Two nearly equal points this close would reach the slide as one twitch that interrupts the stroke: keep only the newer.
      if (last && t - last.t < 150 && Math.abs(v - last.v) < .15 && pts.length - 1 >= this.sentIdx) { last.t = t; last.v = v; return; }
      pts.push({t, v});
      if (pts.length > 400) { pts.splice(0, 200); this.sentIdx = Math.max(0, this.sentIdx - 200); }
    }

    // Turn one frame's shift into stroke points: one at every peak, plus one at least every maxSeg ms.
    track(dx, dy, t) {
      dx /= N; dy /= N;
      this.sxx = this.sxx * .98 + dx * dx; this.sxy = this.sxy * .98 + dx * dy; this.syy = this.syy * .98 + dy * dy;
      const a = Math.atan2(2 * this.sxy, this.sxx - this.syy) / 2;   // the line the motion has mostly been running along
      let ax = Math.cos(a), ay = Math.sin(a);
      if (Math.abs(ay) >= Math.abs(ax) ? ay > 0 : ax < 0) { ax = -ax; ay = -ay; }   // up (or right) counts as positive
      // Leaky sum: a steady drift (camera pan, scrolling background) fades out instead of pinning every stroke at one end.
      this.pos = this.pos * Math.exp(-(t - this.lastT) / 1500) + dx * ax + dy * ay;
      this.lastT = t;
      const pos = this.pos, s = this.samples;

      s.push([t, pos]);
      while (s[0][0] < t - 4000) s.shift();
      let lo = Infinity, hi = -Infinity;
      for (const [, p] of s) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
      const range = hi - lo, r = this.roi;
      if (this.log) this.log.push([Math.round(t), +dx.toFixed(3), +dy.toFixed(3), +pos.toFixed(4), +range.toFixed(4), r.x.toFixed(2), r.y.toFixed(2), r.w.toFixed(2), r.h.toFixed(2)]);
      if (range < .03) { this.cand = null; return; }   // nothing is really moving
      const norm = p => (p - lo) / range;

      if (!this.cand || (pos - this.cand[1]) * this.dir >= 0) this.cand = [t, pos];   // still heading the same way
      else if ((this.cand[1] - pos) * this.dir > Math.max(range * .1, .01)) {          // turned around for real: cand was a peak
        this.addPoint(this.cand[0], norm(this.cand[1]));
        this.dir = -this.dir; this.cand = [t, pos];
      }
      const last = this.points[this.points.length - 1], cand = this.cand;
      if (!last || t - last.t > this.maxSeg) {
        if (last && cand[0] <= last.t) this.addPoint(t, norm(pos)); else this.addPoint(cand[0], norm(cand[1]));
      }
    }

    // Stroke value (0..1) at time t, interpolated between points.
    valueAt(t) {
      const pts = this.points;
      for (let i = pts.length - 1; i > 0; i--) if (pts[i - 1].t <= t) {
        const a = pts[i - 1], b = pts[i];
        return t >= b.t ? b.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
      }
      return pts[0]?.v ?? .5;
    }
  }

  // Shift estimation on a smooth random texture; logs a console error if it is off.
  function selfTest() {
    let a = Float32Array.from({length: N * N}, () => Math.random() * 256);
    for (let pass = 0; pass < 3; pass++) a = a.map((_, i) => {
      const x = i % N, y = i / N | 0; let s = 0, n = 0;
      for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) if (xx >= 0 && xx < N && yy >= 0 && yy < N) { s += a[yy * N + xx]; n++; }
      return s / n;
    });
    a = Uint8Array.from(a, v => Math.max(0, Math.min(255, (v - 128) * 3 + 128)));
    let ok = true;
    for (const [dx, dy] of [[3, -5], [-2, 4], [0, 0], [2, -12]]) {
      const b = new Uint8Array(N * N).fill(128);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const sx = x - dx, sy = y - dy;
        if (sx >= 0 && sx < N && sy >= 0 && sy < N) b[y * N + x] = a[sy * N + sx];
      }
      const [ex, ey] = flow(a, b);
      if (Math.abs(ex - dx) >= .5 || Math.abs(ey - dy) >= .5) { ok = false; console.error('tracker self-test is off', dx, dy, ex, ey); }
    }
    return ok;
  }

  return {Tracker, estimateShift, flow, half, selfTest, N, G};
})();
