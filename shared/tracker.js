// Motion tracker: turns video frames into stroke points. No DOM beyond one scratch canvas.
// Classic script so content scripts and plain pages can load it; defines globalThis.HandyTracker.
globalThis.HandyTracker = (() => {
  const N = 48, MAX = 8;   // tracker grid size, and the largest per-frame shift it searches (grid px)
  const G = 32;            // grid for the "where is the motion" map
  const C = 8, K = G / C;  // the automatic box looks at C×C cells of K×K grid px
  const NOISE = 4;         // squared brightness slope per grid px below which a cell counts as flat (a guess: grain of about 2 levels)
  const FLOOR = .25;
  const BIN = 50, L = 120; // and keeps each cell's motion in 50 ms steps for 6 s: three half-strokes at the slowest rate it accepts

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
    constructor({maxSeg = 400, keep = 400} = {}) {
      this.maxSeg = maxSeg;            // ms: longest gap between stroke points
      this.keep = keep;                // points kept in memory (live play trims old ones; a scan keeps all)
      this.ban = new Float32Array(C * C);   // per cell: video ms until which "Not this" keeps it out of the box
      this.roi = {x: .3, y: .1, w: .4, h: .8};
      this.auto = true;
      this.energy = new Float32Array(G * G);
      this.hist = new Float32Array(2 * C * C * L);   // per cell: x shifts, then y shifts, newest last
      this.fit = new Float32Array(2 * C * C);        // per cell: brightness change a shift explained, and all of it
      this.points = [];                // {t, v}: stroke points, v from 0 (bottom) to 1 (top)
      this.sentIdx = 0;                // points before this index were handed on and must not change
      this.log = null;                 // set to an array to record per-frame numbers
      this.onRoi = null;               // called when the box moves
      const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(N, N) : Object.assign(document.createElement('canvas'), {width: N, height: N});
      this.scratch = c.getContext('2d', {willReadFrequently: true});
      this.reset();
    }

    reset() {
      this.prev = this.prevFull = null; this.bins = this.bin = this.fullT = this.roiT = this.held = this.heldT = 0; this.hist.fill(0); this.fit.fill(0);
      this.sxx = 0; this.sxy = 0; this.syy = 1e-6; this.pos = 0; this.lastT = 0;
      this.samples = []; this.dir = 1; this.cand = null; this.net = this.path = 0; this.conf = 1; this.pend = null; this.cutT = -1e9;
      this.energy.fill(0);
    }

    setRoi(roi, manual = true) {
      this.roi = roi; this.prev = null;
      this.net = this.path = 0;   // what the old box saw says nothing about this one
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
      this.t = t;
      const full = this.gray(source, sw, sh, 0, 0, 1, 1, G), e = this.energy;
      if (this.prevFull) for (let i = 0; i < full.length; i++) e[i] = e[i] * .96 + Math.abs(full[i] - this.prevFull[i]);
      if (this.prevFull) this.cells(this.prevFull, full, this.fullT, t);
      this.prevFull = full; this.fullT = t;
      if (this.auto && Math.abs(t - this.roiT) >= 250) { this.roiT = t; this.autoRoi(t); }
      // Measure the box over at least 30 ms of video (from C): at 60 fps one frame's change is too small to see.
      if (this.prev && t > this.prevT && t - this.prevT < 30) return;
      const r = this.roi, cur = this.gray(source, sw, sh, r.x, r.y, r.w, r.h, N);
      if (this.prev && t > this.prevT) this.track(...flow(this.prev, cur), t);
      this.prev = cur; this.prevT = t;
    }

    // How far each cell's picture moved since the last frame, added to the cell's history.
    cells(a, b, t0, t1) {
      const h = this.hist, fit = this.fit, n = C * C, fx = new Float32Array(n), fy = new Float32Array(n), mx = [], my = [];
      const dt = t1 - t0, keep = Math.exp(-dt / 2000);
      let cut = dt > 0 && dt < 250 ? 0 : n;   // a seek or a stall counts as a cut
      for (let c = 0; c < n; c++) {
        // Least-squares shift (Lucas-Kanade), with the cell's mean brightness change left out so a flicker is not read as a shift.
        const cx = c % C * K, cy = (c / C | 0) * K;
        let m = 0, sx = 0, sy = 0, st = 0, xx = 0, xy = 0, yy = 0, xt = 0, yt = 0, tt = 0;
        for (let y = Math.max(1, cy); y < Math.min(G - 1, cy + K); y++) for (let x = Math.max(1, cx), i = y * G + x; x < Math.min(G - 1, cx + K); x++, i++) {
          const ix = (a[i + 1] - a[i - 1] + b[i + 1] - b[i - 1]) / 4, iy = (a[i + G] - a[i - G] + b[i + G] - b[i - G]) / 4, it = b[i] - a[i];
          m++; sx += ix; sy += iy; st += it; xx += ix * ix; xy += ix * iy; yy += iy * iy; xt += ix * it; yt += iy * it; tt += it * it;
        }
        fit[2 * c + 1] = fit[2 * c + 1] * keep + tt;   // all of the change, a plain brightening included
        xx -= sx * sx / m; xy -= sx * sy / m; yy -= sy * sy / m; xt -= sx * st / m; yt -= sy * st / m; tt -= st * st / m;
        const flat = xx + yy < 2 * NOISE * m;
        xx += NOISE * m; yy += NOISE * m;   // a cell with no detail gets no shift instead of a wild one
        const det = xx * yy - xy * xy;
        fx[c] = (xy * yt - yy * xt) / det; fy[c] = (xy * xt - xx * yt) / det;
        fit[2 * c] = fit[2 * c] * keep - fx[c] * xt - fy[c] * yt;
        if (tt + fx[c] * xt + fy[c] * yt > (xx + yy) / 2) cut++;   // more change left over than a shift of one grid px makes
        if (!flat) { mx.push(fx[c]); my.push(fy[c]); }
      }
      // Most cells changed in a way no shift explains: a cut. What came before no longer counts, for the box and for the stroke.
      if (2 * cut > n) { this.bins = this.held = 0; this.cutT = t1; fit.fill(0); this.prev = null; return; }
      // What most of the picture did is the camera, not the subject: take it out.
      const camX = mx.sort((p, q) => p - q)[mx.length >> 1] || 0, camY = my.sort((p, q) => p - q)[my.length >> 1] || 0;
      for (let bin = Math.floor(t0 / BIN); bin <= Math.floor(t1 / BIN); bin++) {   // spread the shift over the 50 ms steps the frame covered
        if (bin !== this.bin) { this.bin = bin; this.bins++; h.copyWithin(0, 1); for (let r = 1; r <= 2 * n; r++) h[r * L - 1] = 0; }
        const w = (Math.min(t1, (bin + 1) * BIN) - Math.max(t0, bin * BIN)) / dt;
        for (let c = 0; c < n; c++) { h[(2 * c + 1) * L - 1] += w * (fx[c] - camX); h[(2 * c + 2) * L - 1] += w * (fy[c] - camY); }
      }
    }

    // How rhythmic one cell's motion is, 0 to 1: the motion half a stroke period ago was the opposite and a full
    // period ago the same. Steady one-way motion never reverses and random change never repeats, so both score near 0.
    // Returns [score, strength of the motion, bins looked at].
    rhythm(c) {
      const h = this.hist, X = 2 * c * L, Y = X + L, n = Math.min(this.bins, L), P = new Float64Array(L + 1);
      for (let i = L - n; i < L; i++) P[i + 1] = P[i] + h[X + i] * h[X + i] + h[Y + i] * h[Y + i];
      const r = (lag, m) => {
        let s = 0;
        for (let i = L - m; i < L; i++) s += h[X + i] * h[X + i - lag] + h[Y + i] * h[Y + i - lag];
        return s / Math.sqrt((P[L] - P[L - m]) * (P[L - lag] - P[L - m - lag]) + 1e-12);
      };
      let best = [0, 0, 0];
      for (let tau = 2; tau * BIN <= 1667; tau++) {   // half periods of 0.1 to 1.67 s: 5 down to 0.3 strokes a second
        const m = Math.min(n - 2 * tau - 1, Math.max(20, 4 * tau));
        if (m < Math.max(20, tau)) break;             // needs a second of motion, and half a period beyond the two it compares
        const s = Math.min(-r(tau, m), Math.max(r(2 * tau - 1, m), r(2 * tau, m), r(2 * tau + 1, m)));
        if (s > best[0]) best = [s, (P[L] - P[L - m]) / m, m + 2 * tau];
      }
      return best;
    }

    // Move the box onto the cells that move back and forth in rhythm. With nothing rhythmic in the picture it stays where it is.
    autoRoi(t) {
      const h = this.hist, fit = this.fit, n = C * C, r = this.roi;
      let seed = -1, top = [0, 0, 0], mine = false;
      for (let c = 0; c < n; c++) if (!(this.ban[c] > t) && fit[2 * c] > .5 * fit[2 * c + 1]) {   // only where a shift explains most of the change
        const s = this.rhythm(c), x = (c % C + .5) / C - r.x, y = ((c / C | 0) + .5) / C - r.y, own = x > 0 && x < r.w && y > 0 && y < r.h;
        // A cell outside the box has to move twice as fast (4 times the strength) as one inside to take the box over,
        if (s[0] >= .5 && s[1] * (own ? 4 : 1) > top[1] * (mine ? 4 : 1)) { top = s; seed = c; mine = own; }
      }
      // and with nothing rhythmic left in the box, twice as fast as what the box last followed; that bar halves every 1.4 s.
      if (seed < 0 || !mine && top[1] < 4 * this.held * Math.exp(-(t - this.heldT) / 2000)) return;
      this.held = top[1]; this.heldT = t;
      // Cells that moved with the strongest rhythmic cell (or against it), joined to it: weight = how much of its motion they show.
      const w = new Float32Array(n), from = L - top[2], dot = (p, q) => {
        let s = 0;
        for (let i = from; i < L; i++) s += h[2 * p * L + i] * h[2 * q * L + i] + h[(2 * p + 1) * L + i] * h[(2 * q + 1) * L + i];
        return s;
      };
      const own = dot(seed, seed), todo = [seed];
      w[seed] = 1;
      while (todo.length) {
        const c = todo.pop(), x = c % C, y = c / C | 0;
        for (const [p, q] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          const d = q * C + p;
          if (p < 0 || p >= C || q < 0 || q >= C || w[d] || this.ban[d] > t) continue;
          const s = Math.abs(dot(d, seed));
          if (s * s >= .25 * own * dot(d, d) && s >= FLOOR * own) { w[d] = Math.min(1, s / own); todo.push(d); }
        }
      }
      this.w = w;
      const wx = new Float32Array(C), wy = new Float32Array(C);
      for (let i = 0; i < n; i++) { wx[i % C] = Math.max(wx[i % C], w[i]); wy[i / C | 0] = Math.max(wy[i / C | 0], w[i]); }
      // From the group's first column (row) to its last; an outer one the subject only partly covers counts for that part.
      const span = v => {
        let a = 0, b = C - 1;
        while (!v[a]) a++;
        while (!v[b]) b--;
        const lo = a + 1 - v[a], hi = b + v[b], half = Math.max(.1 * C, (hi - lo) / 2);
        return [Math.max(0, ((lo + hi) / 2 - half) / C), Math.min(1, ((lo + hi) / 2 + half) / C)];
      };
      const [x0, x1] = span(wx), [y0, y1] = span(wy);
      const moved = Math.max(Math.abs(x0 - r.x), Math.abs(y0 - r.y), Math.abs(x1 - r.x - r.w), Math.abs(y1 - r.y - r.h));
      // Stickiness: a new box is taken only when the previous proposal pointed at the same place (overlap > half).
      const nb = {x: x0, y: y0, w: x1 - x0, h: y1 - y0}, p = this.pend, iou = (a, b) => {
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)), iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        return ix * iy / (a.w * a.h + b.w * b.h - ix * iy);
      };
      this.pend = nb;
      if (moved > .08 && (p && iou(p, nb) > .5 || t - this.cutT < 2000))   // right after a cut the old box means nothing
        this.setRoi(nb, false);
    }

    // "Not this": the box is on the wrong thing (a fire, a TV). Keep the cells under it out of the automatic box
    // for 2 minutes of video and look again now; pressed again, it moves on to the next spot.
    skip() {
      const r = this.roi, t = this.t || 0;
      for (let c = 0; c < C * C; c++) {
        const x = (c % C + .5) / C, y = ((c / C | 0) + .5) / C;
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) this.ban[c] = t + 120000;
      }
      this.auto = true; this.held = 0; this.pend = null; this.cutT = t;   // like a cut: the next good spot is taken at once
      this.autoRoi(t);
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
      if (pts.length > this.keep) { pts.splice(0, 200); this.sentIdx = Math.max(0, this.sentIdx - 200); }
    }

    // Turn one frame's shift into stroke points: one at every peak, plus one at least every maxSeg ms.
    track(dx, dy, t) {
      dx /= N; dy /= N;
      this.sxx = this.sxx * .98 + dx * dx; this.sxy = this.sxy * .98 + dx * dy; this.syy = this.syy * .98 + dy * dy;
      const a = Math.atan2(2 * this.sxy, this.sxx - this.syy) / 2;   // the line the motion has mostly been running along
      let ax = Math.cos(a), ay = Math.sin(a);
      if (Math.abs(ay) >= Math.abs(ax) ? ay > 0 : ax < 0) { ax = -ax; ay = -ay; }   // up (or right) counts as positive
      // Leaky sum: a steady drift (camera pan, scrolling background) fades out instead of pinning every stroke at one end.
      const d = dx * ax + dy * ay, keep = Math.exp(-(t - this.lastT) / 3000);
      this.pos = this.pos * Math.exp(-(t - this.lastT) / 1500) + d;
      this.lastT = t;
      // Confidence (from C): the share of the box's recent travel that was undone again. Strokes come back, drift does not.
      this.net = this.net * keep + d; this.path = this.path * keep + Math.abs(d);
      this.conf = 1 - Math.abs(this.net) / (this.path + .3);
      const pos = this.pos, s = this.samples;

      s.push([t, pos]);
      while (s[0][0] < t - 4000) s.shift();
      let lo = Infinity, hi = -Infinity;
      for (const [, p] of s) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
      const range = hi - lo, r = this.roi;
      if (this.log) this.log.push([Math.round(t), +dx.toFixed(3), +dy.toFixed(3), +pos.toFixed(4), +range.toFixed(4), r.x.toFixed(2), r.y.toFixed(2), r.w.toFixed(2), r.h.toFixed(2)]);
      if (range < .03 || this.auto && this.conf < .5) { this.cand = null; return; }   // nothing is really moving
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
