/* musicbox lyrics - drawing karaoke on a canvas: the lyrics bar (sung part swept in colour,
 * lead-in bars), the note lane and the word map. Shared by the YouTube overlay (content.js) and the
 * karaoke web page. The look follows the musicbox player (iOS 6 style). */
(function (root) {
  "use strict";
  const C = root.MbxChart;
  const FONT = '"Helvetica Neue", Helvetica, Arial, "Segoe UI", sans-serif';
  const BLUE = ["#76b2ff", "#1c62de"], PINK = ["#ffb4d2", "#dc4682"], GOLD = ["#ffe278", "#dea018"];
  const SUNG = ["#6eb2ff", "#ff96be"];

  function rr(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function vgrad(ctx, y, h, top, bottom) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  }

  /* black glass: dark gradient, a faint gloss on the top half, a highlight line on top */
  function glass(ctx, x, y, w, h, r) {
    rr(ctx, x, y, w, h, r);
    ctx.fillStyle = vgrad(ctx, y, h, "rgba(46,48,54,0.84)", "rgba(8,9,11,0.9)");
    ctx.fill();
    rr(ctx, x, y, w, h / 2, r);
    ctx.fillStyle = vgrad(ctx, y, h / 2, "rgba(255,255,255,0.10)", "rgba(255,255,255,0.025)");
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fillRect(x + r, y, w - 2 * r, 1);
  }

  /* a glossy capsule (note bars) */
  function capsule(ctx, x, y, w, h, top, bottom) {
    w = Math.max(w, h);
    rr(ctx, x, y + 1.5, w, h, h / 2);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fill();
    rr(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = vgrad(ctx, y, h, top, bottom);
    ctx.fill();
    rr(ctx, x + h * 0.15, y + h * 0.08, w - h * 0.3, h * 0.45, h * 0.22);
    ctx.fillStyle = vgrad(ctx, y, h * 0.5, "rgba(255,255,255,0.47)", "rgba(255,255,255,0.08)");
    ctx.fill();
  }

  function setFont(ctx, px, bold) {
    ctx.font = `${bold ? "bold " : ""}${px}px ${FONT}`;
  }

  /* one line of lyrics, centred; current: white with the sung part in colour (clipped) */
  /* the line's size and widths, measured once per line and size (measuring every frame is slow) */
  const widthCache = new Map();
  function measure(ctx, tr, li, px, maxw) {
    const key = tr.lines[li].first + "|" + px + "|" + maxw;
    let m = widthCache.get(key);
    if (m) return m;
    const l = tr.lines[li];
    setFont(ctx, px, true);
    let w = ctx.measureText(l.text).width;
    if (w > maxw) {
      px = Math.floor((px * maxw) / w);
      setFont(ctx, px, true);
      w = ctx.measureText(l.text).width;
    }
    const notes = [];
    for (let i = l.first; i < l.first + l.count; i++) notes.push(ctx.measureText(tr.notes[i].text).width);
    if (widthCache.size > 400) widthCache.clear();
    m = { px, w, notes };
    widthCache.set(key, m);
    return m;
  }

  /* A line's text as an image, made once and reused every frame: drawing text is the costliest thing
   * here, and a weak TV chip notices. Same pixels as drawing it directly: the shadow and the text
   * ("base"), or just the text in the sung colour. A few lines are kept. */
  const textCache = new Map();
  function textImage(text, px, kind, colour) {
    const key = kind + "|" + colour + "|" + px + "|" + text;
    let img = textCache.get(key);
    if (img) return img;
    const probe = document.createElement("canvas").getContext("2d");
    setFont(probe, px, true);
    const o = Math.max(1, px / 28), pad = 2;
    const w = Math.ceil(probe.measureText(text).width + o + pad * 2), h = Math.ceil(px * 1.35 + o + pad * 2);
    img = document.createElement("canvas");
    img.width = Math.max(1, w);
    img.height = Math.max(1, h);
    const g = img.getContext("2d");
    setFont(g, px, true);
    g.textBaseline = "top";
    if (kind === "base") {
      g.fillStyle = "rgba(0,0,0,0.65)";
      g.fillText(text, pad + o, pad + o);
    }
    g.fillStyle = colour;
    g.fillText(text, pad, pad);
    if (textCache.size > 24) textCache.delete(textCache.keys().next().value);
    textCache.set(key, img);
    return img;
  }

  function drawLine(ctx, s, tr, li, t, cx, y, px, maxw, sung, current) {
    const l = tr.lines[li];
    const m = measure(ctx, tr, li, px, maxw);
    px = m.px;
    const w = m.w;
    setFont(ctx, px, true);
    const x = Math.round(cx - w / 2);
    y = Math.round(y);
    const base = textImage(l.text, px, "base", current ? "#fff" : "rgba(205,208,214,0.85)");
    ctx.drawImage(base, x - 2, y - 2);
    if (!current) return;
    /* how far the singing has got: through the note being sung, in proportion */
    const b = C.timeBeat(s, t);
    let sx = x, done = false, cue = null;
    for (let i = l.first, nx = x; i < l.first + l.count; i++) {
      const n = tr.notes[i], nw = m.notes[i - l.first];
      /* a pause before this word (inside the line): a small bar under it fills up to its start */
      if (i > l.first && !cue && n.text.trim()) {
        const prev = tr.notes[i - 1];
        const fill = leadIn(C.beatTime(s, prev.start + prev.len), C.beatTime(s, n.start), t, WORD_MIN_S);
        if (fill != null) cue = { x: nx, w: Math.max(nw - px * 0.25, px * 0.8), fill };
      }
      if (!done) {
        if (b < n.start) done = true;
        else if (b < n.start + n.len) {
          sx += (nw * (b - n.start)) / n.len;
          done = true;
        } else sx += nw;
      }
      nx += nw;
    }
    /* before the line: the lead-in bar just left of the first word, reaching it as singing starts */
    const prevEnd = li > 0 ? C.beatTime(s, tr.lines[li - 1].end) : -Infinity;
    const lead = leadIn(prevEnd, C.beatTime(s, l.start), t, LEAD_MIN_S);
    if (lead != null) leadBar(ctx, x - px * 0.35 - px * 2.6, y + px * 0.38, px * 2.6, px * 0.34, lead, sung);
    if (cue) leadBar(ctx, cue.x, y + px * 1.12, cue.w, px * 0.16, cue.fill, sung, true);
    if (sx <= x) return;
    /* the sung part: the same line in the sung colour, up to where the singing has got */
    const lit = textImage(l.text, px, "sung", sung);
    const sw = Math.min(lit.width, Math.ceil(sx - x) + 2);
    if (sw > 0) ctx.drawImage(lit, 0, 0, sw, lit.height, x - 2, y - 2, sw, lit.height);
  }

  /* Lead-ins (as in UltraStar and the old Stage): 0..1 as a bar fills over the rest before
   * something is sung, reaching 1 exactly as it starts; null when there is none to show. It runs
   * over the rest, at most LEAD_MAX_S, and only when the rest is long enough to see. */
  const LEAD_MAX_S = 3, LEAD_MIN_S = 0.6, WORD_MIN_S = 1.0;
  function leadIn(restStart, start, t, minRest) {
    const win = Math.min(LEAD_MAX_S, start - restStart);
    if (!(win >= minRest) || t >= start || t < start - win) return null;
    return (t - (start - win)) / win;
  }

  /* a dark groove with a glossy blue fill; the line's version has a marker at its end */
  function leadBar(ctx, x, y, w, h, fill, colour, thin) {
    rr(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = vgrad(ctx, y, h, "#08090a", "#26282c");
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.lineWidth = 1;
    ctx.stroke();
    if (fill > 0) {
      rr(ctx, x, y, Math.max(h, w * fill), h, h / 2);
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, "#a9d0ff");
      g.addColorStop(0.48, "#4f8fe8");
      g.addColorStop(0.52, "#2f6ad3");
      g.addColorStop(1, "#2457b8");
      ctx.fillStyle = g;
      ctx.fill();
    }
    if (!thin) {
      const mw = h * 0.9, mh = h * 2.6;
      rr(ctx, x + w - mw / 2, y + h / 2 - mh / 2, mw, mh, mw * 0.3);
      ctx.fillStyle = colour;
      ctx.fill();
    }
  }

  /* The word map along the bottom: the whole song, every sung word a lighter block, the elapsed
   * part in blue, a playhead. Times are on the video's clock. */
  function mapLayer(s, offset, dur, w, h, sung) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    const g = c.getContext("2d");
    rr(g, 0.5, 0.5, w - 1, h - 1, h / 2);
    if (sung) {
      const fill = g.createLinearGradient(0, 0, 0, h);
      fill.addColorStop(0, "#a9d0ff");
      fill.addColorStop(0.48, "#4f8fe8");
      fill.addColorStop(0.52, "#2f6ad3");
      fill.addColorStop(1, "#2457b8");
      g.fillStyle = fill;
    } else g.fillStyle = vgrad(g, 0, h, "#08090a", "#26282c");
    g.fill();
    g.strokeStyle = "#000";
    g.lineWidth = 1;
    g.stroke();
    g.save();
    g.clip();
    g.fillStyle = sung ? "rgba(214,234,255,0.85)" : "rgba(150,156,170,0.75)";
    const spans = [];
    for (const tr of s.tracks)
      for (const n of tr.notes) spans.push([C.beatTime(s, n.start) + offset, C.beatTime(s, n.start + n.len) + offset]);
    spans.sort((a, b) => a[0] - b[0]);
    let a0 = null, a1 = 0;
    const flush = () => a0 != null && g.fillRect((a0 / dur) * w, 1, Math.max(1, ((a1 - a0) / dur) * w), h - 2);
    for (const [b0, b1] of spans) {
      if (a0 != null && b0 - a1 <= dur / w) a1 = Math.max(a1, b1);
      else {
        flush();
        a0 = b0;
        a1 = b1;
      }
    }
    flush();
    g.restore();
    return c;
  }

  /* The word map along the bottom: the whole song, every sung word a lighter block, the elapsed
   * part in blue, a playhead. Times are on the video's clock. */
  function wordMap(ctx, st, s, offset, t, dur, x, y, w, h) {
    const key = [Math.round(w), Math.round(h), dur].join("|");
    if (!st.map || st.map.key !== key)
      st.map = { key, todo: mapLayer(s, offset, dur, w, h, false), sung: mapLayer(s, offset, dur, w, h, true) };
    const head = Math.max(0, Math.min(1, (t + offset) / dur)) * w;
    ctx.drawImage(st.map.todo, x, y);
    if (head >= 1) ctx.drawImage(st.map.sung, 0, 0, head, st.map.sung.height, x, y, head, st.map.sung.height);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillRect(x + head - 1, y - h * 0.25, 2, h * 1.5);
  }


  /* the current line's notes by pitch, the passed part lit, a playhead */
  function drawLane(ctx, s, tr, t, x, y, w, h, colours) {
    const li = C.lineAt(s, tr, t);
    if (li < 0) return;
    const l = tr.lines[li];
    let pmin = Infinity, pmax = -Infinity;
    for (let i = l.first; i < l.first + l.count; i++) {
      pmin = Math.min(pmin, tr.notes[i].pitch);
      pmax = Math.max(pmax, tr.notes[i].pitch);
    }
    let span = pmax - pmin;
    if (span < 12) {
      pmin -= Math.floor((12 - span) / 2);
      span = 12;
    }
    const barH = h / 9, pad = w * 0.04, iw = w - 2 * pad;
    const b0 = l.start, b1 = Math.max(l.end, l.start + 1), b = C.timeBeat(s, t);
    for (let i = l.first; i < l.first + l.count; i++) {
      const n = tr.notes[i];
      const nx = x + pad + ((n.start - b0) / (b1 - b0)) * iw, nw = (n.len / (b1 - b0)) * iw;
      const ny = y + h - barH - ((n.pitch - pmin) / span) * (h - barH * 1.4) - barH * 0.2;
      const golden = n.type === "golden" || n.type === "rapgolden";
      ctx.globalAlpha = n.type === "freestyle" ? 0.45 : 1;
      capsule(ctx, nx, ny, nw, barH, golden ? GOLD[0] : "rgba(250,251,253,0.92)", golden ? GOLD[1] : "rgba(186,192,204,0.92)");
      if (b > n.start) {
        const lit = b >= n.start + n.len ? nw + barH : (nw * (b - n.start)) / n.len;
        ctx.save();
        ctx.beginPath();
        ctx.rect(nx - barH, ny - 4, lit + barH, barH + 8);
        ctx.clip();
        capsule(ctx, nx, ny, nw, barH, golden ? "#fff4be" : colours[0], golden ? "#f0be3c" : colours[1]);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    if (b >= b0 - 0.5 && b <= b1 + 0.5) {
      const px = x + pad + ((b - b0) / (b1 - b0)) * iw;
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.fillRect(px - 3, y + 6, 6, h - 12);
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillRect(px - 1, y + 6, 2, h - 12);
    }
  }

  /* One frame. v: {song, offset (video time - song time), t (song time), dur (video length, 0 =
   * unknown), W, H (canvas pixels), u (scale: 1 at 1080 lines), lift (pixels kept clear at the
   * bottom), notes, map (what to show), st (state kept between frames: fade, cached layers)}. */
  function render(ctx, v) {
    const { song: s, offset, t, dur, W, H, u, lift, notes, map, st } = v;
    const settings = { notes, map };
    /* show only near singing: from 6 s before a line until it ends */
    let near = false;
    for (const tr of s.tracks) {
      const li = C.lineAt(s, tr, t);
      if (li >= 0 && C.beatTime(s, tr.lines[li].start) - t < 6) near = true;
    }
    st.alphaTarget = near ? 1 : 0;
    st.alpha += (st.alphaTarget - st.alpha) * 0.12;
    if (Math.abs(st.alpha - st.alphaTarget) < 0.005) st.alpha = st.alphaTarget;


    /* the word map: always there, along the bottom */
    const mapH = 16 * u, mapPad = 12 * u, mapY = H - lift - mapPad - mapH;
    if (settings.map && dur > 0) {
      ctx.globalAlpha = 1;
      glass(ctx, 0, mapY - mapPad, W, mapH + 2 * mapPad, 0);
      wordMap(ctx, st, s, offset, t, dur, 24 * u, mapY, W - 48 * u, mapH);
    }
    const bottom = settings.map && dur > 0 ? mapY - mapPad : H - lift;
    if (st.alpha < 0.01) return;
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.globalAlpha = st.alpha;
    ctx.globalCompositeOperation = "source-over";

    const duet = s.tracks.length === 2;
    const barH = (duet ? 280 : 220) * u, barY = bottom - barH;
    ctx.save();
    ctx.globalAlpha *= 1;
    glass(ctx, 0, barY, W, barH, 0);
    ctx.restore();
    ctx.globalAlpha = st.alpha;
    const big = 64 * u, small = 42 * u, maxw = W - 100 * u;
    s.tracks.forEach((tr, k) => {
      const y = duet ? barY + 26 * u + k * 130 * u : barY + 32 * u;
      const li = C.lineAt(s, tr, t);
      if (li < 0) return;
      drawLine(ctx, s, tr, li, t, W / 2, y, duet ? big * 0.85 : big, maxw, SUNG[k], true);
      if (!duet && li + 1 < tr.lines.length) drawLine(ctx, s, tr, li + 1, t, W / 2, y + big * 1.35, small, maxw, SUNG[0], false);
    });

    /* the note panel fits above the lyrics bar; skipped when the player is too small for it */
    const lx = 60 * u, ly = 40 * u, lw = W - 120 * u, lh = Math.min(280 * u, barY - ly - 24 * u);
    if (settings.notes && lh >= 120 * u) {
      ctx.globalAlpha = st.alpha * 0.7;
      glass(ctx, lx, ly, lw, lh, 18 * u);
      ctx.globalAlpha = st.alpha;
      if (duet) {
        drawLane(ctx, s, s.tracks[0], t, lx, ly, lw, lh / 2, BLUE);
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.fillRect(lx + 20 * u, ly + lh / 2, lw - 40 * u, 1);
        drawLane(ctx, s, s.tracks[1], t, lx, ly + lh / 2, lw, lh / 2, PINK);
      } else drawLane(ctx, s, s.tracks[0], t, lx, ly, lw, lh, BLUE);
    }
    ctx.restore();
  }

  root.MbxDraw = { render, leadIn };
})(typeof globalThis !== "undefined" ? globalThis : this);
