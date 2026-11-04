/* musicbox karaoke - scoring a singer on their own phone.
 *
 * Latency doesn't matter: the phone knows the song (the chart), knows where the TV is in it (the
 * screen announces its position through the live database), hears the singer itself, and finds
 * the leftover delay (mic, Wi-Fi, the TV's own) by trying shifts and keeping the one that fits the
 * notes best - like UltraStar's mic delay setting, but automatic, and per phone.
 *
 * Points as in UltraStar: 9,000 for the notes (golden notes count double, rap notes need only a
 * voice, freestyle notes don't count) and 1,000 for good lines. A note is hit when the voice is
 * within a semitone of it, in any octave. Each line is scored when it's over (plus a moment for
 * the delay), so the delay found by then applies to the whole line.
 *
 *   MbxScore.pitch(samples, sampleRate) -> {midi, confidence} | null        (YIN)
 *   new MbxScore.Singer(song, part)  .add(t, midi|null) for each 20 ms frame (song time t)
 *                                    .update(t) -> lines newly scored [{line, ratio, rating}]
 *                                    .score, .delay */
(function (root) {
  "use strict";
  const C = root.MbxChart;

  /* ------------------------------------------------------------------ pitch (YIN) */
  function pitch(buf, sr, minF = 75, maxF = 1100) {
    /* halve the rate first (a quarter of the work; voices are well below 6 kHz) */
    const half = new Float32Array(buf.length >> 1);
    for (let i = 0; i < half.length; i++) half[i] = (buf[2 * i] + buf[2 * i + 1]) * 0.5;
    const rate = sr / 2, x = half;
    const maxTau = Math.min(Math.floor(rate / minF), (x.length >> 1) - 1), minTau = Math.max(2, Math.floor(rate / maxF));
    const n = x.length - maxTau;
    const d = new Float32Array(maxTau + 1);
    for (let tau = 1; tau <= maxTau; tau++) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const v = x[i] - x[i + tau];
        s += v * v;
      }
      d[tau] = s;
    }
    /* cumulative mean normalised difference: the first dip under the threshold is the period */
    let run = 0, best = -1;
    const cm = new Float32Array(maxTau + 1);
    cm[0] = 1;
    for (let tau = 1; tau <= maxTau; tau++) {
      run += d[tau];
      cm[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (cm[tau] < 0.15) {
        while (tau + 1 <= maxTau && cm[tau + 1] < cm[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) return null;
    /* between samples: a parabola through the dip */
    const a = cm[best - 1] ?? cm[best], b = cm[best], c = cm[best + 1] ?? cm[best];
    const shift = a + c - 2 * b ? (a - c) / (2 * (a + c - 2 * b)) : 0;
    const f = rate / (best + shift);
    return { midi: 69 + 12 * Math.log2(f / 440), confidence: 1 - b };
  }

  /* ------------------------------------------------------------------ one singer */
  const STEP = 0.02; /* seconds per pitch frame */
  const EDGE = 0.04; /* a note counts this much before and after it too: timing never lines up to the frame */
  const RATINGS = [[0.9, "Perfect!"], [0.75, "Great!"], [0.55, "Good"], [0.3, "OK"], [0, "Keep going"]];

  class Singer {
    constructor(song, part = 0) {
      this.song = song;
      this.track = song.tracks[Math.min(part, song.tracks.length - 1)];
      this.delay = 0.15; /* a typical start; it's found while singing */
      this.frames = []; /* [t, midi|null] */
      this.done = new Set(); /* lines scored */
      this.points = 0;
      this.linePoints = 0;
      /* what a perfect run is worth */
      this.notes = this.track.notes.map((n) => ({
        n,
        t0: C.beatTime(song, n.start),
        t1: C.beatTime(song, n.start + n.len),
        w: n.type === "freestyle" ? 0 : n.len * (n.type === "golden" || n.type === "rapgolden" ? 2 : 1),
      }));
      this.total = this.notes.reduce((s, x) => s + x.w, 0) || 1;
      this.scoredLines = this.track.lines.filter((l) => this.notes.slice(l.first, l.first + l.count).some((x) => x.w > 0)).length || 1;
    }

    get score() {
      return Math.round((9000 * this.points) / this.total + (1000 * this.linePoints) / this.scoredLines);
    }

    add(t, midi) {
      this.frames.push([t, midi]);
      if (this.frames.length > 3000) this.frames.splice(0, 1000); /* the last minute is plenty */
    }

    hit(x, midi) {
      if (midi == null) return false;
      if (x.n.type === "rap" || x.n.type === "rapgolden") return true;
      const d = (((midi - x.n.pitch) % 12) + 12) % 12; /* any octave */
      return Math.min(d, 12 - d) <= 1.0;
    }

    /* how well the recent singing fits the notes when shifted by d seconds */
    fit(d, since) {
      let hits = 0, j = 0;
      for (const [t, midi] of this.frames) {
        if (t < since || midi == null) continue;
        const ts = t - d;
        while (j < this.notes.length && this.notes[j].t1 < ts) j++;
        if (j > 0 && this.notes[j - 1].t1 >= ts) j--;
        const x = this.notes[j];
        if (x && x.w > 0 && ts >= x.t0 - EDGE && ts <= x.t1 + EDGE && this.hit(x, midi)) hits++;
      }
      return hits;
    }

    /* keep the shift that fits best, if it's clearly better than the current one */
    findDelay(now) {
      const since = now - 25;
      let best = this.delay, bestHits = this.fit(this.delay, since);
      for (let d = -0.2; d <= 0.8001; d += 0.02) {
        const h = this.fit(d, since);
        if (h > bestHits * 1.12 + 2) {
          best = d;
          bestHits = h;
        }
      }
      if (bestHits >= 12) this.delay = best;
    }

    /* score the lines that have ended (plus the longest delay we allow) */
    update(now) {
      const out = [];
      const lines = this.track.lines;
      for (let li = 0; li < lines.length; li++) {
        if (this.done.has(li)) continue;
        const end = C.beatTime(this.song, lines[li].end);
        if (now < end + 0.9) break;
        if (!out.length) this.findDelay(now);
        this.done.add(li);
        let got = 0, worth = 0;
        for (const x of this.notes.slice(lines[li].first, lines[li].first + lines[li].count)) {
          if (!x.w) continue;
          const want = Math.max(1, Math.round((x.t1 - x.t0) / STEP));
          let hits = 0;
          for (const [t, midi] of this.frames) {
            const ts = t - this.delay;
            if (ts >= x.t0 - EDGE && ts < x.t1 + EDGE && this.hit(x, midi)) hits++;
          }
          const ratio = Math.min(1, hits / want);
          got += x.w * ratio;
          worth += x.w;
        }
        if (!worth) continue;
        const ratio = got / worth;
        this.points += got;
        this.linePoints += Math.max(0, Math.min(1, (ratio - 0.4) / 0.5));
        out.push({ line: li, ratio, rating: RATINGS.find(([r]) => ratio >= r)[1] });
      }
      return out;
    }

    /* the song is over: score whatever is left */
    finish() {
      return this.update(1e9);
    }
  }

  root.MbxScore = { pitch, Singer, STEP };
})(typeof globalThis !== "undefined" ? globalThis : this);
