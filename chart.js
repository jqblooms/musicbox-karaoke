/* musicbox lyrics - reading UltraStar charts (the same rules as the player's src/song.c).
 * A beat lasts 60 / (BPM * 4) seconds; beat 0 is at #GAP milliseconds into the audio. */
(function (root) {
  "use strict";

  const NOTE = { ":": "normal", "*": "golden", F: "freestyle", R: "rap", G: "rapgolden" };

  function num(v) {
    return parseFloat(String(v).trim().replace(",", ".")) || 0;
  }

  /* The YouTube ids in "#VIDEO:v=abc,a=def,co=..." (also a bare 11-character id). */
  function sources(videoTag) {
    const out = { v: "", a: "" };
    if (!videoTag) return out;
    for (const part of videoTag.split(",")) {
      const m = part.trim().match(/^([a-z]+)=(.*)$/i);
      if (m && (m[1] === "v" || m[1] === "a")) out[m[1]] = youtubeId(m[2]);
    }
    if (!out.v && !out.a && /^[A-Za-z0-9_-]{11}$/.test(videoTag.trim())) out.v = videoTag.trim();
    return out;
  }

  function youtubeId(s) {
    s = (s || "").trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    const m = s.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : "";
  }

  /* Only the headers (fast; for importing thousands). */
  function headers(text) {
    const h = {};
    for (const raw of text.split(/\r?\n/)) {
      if (raw[0] !== "#") {
        if (raw.trim() && raw[0] !== "#") break;
        continue;
      }
      const c = raw.indexOf(":");
      if (c > 1) h[raw.slice(1, c).trim().toUpperCase()] = raw.slice(c + 1).trim();
    }
    return h;
  }

  function parse(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const song = { artist: "", title: "", bpm: 0, gap: 0, videogap: 0, start: 0, end: 0, video: { v: "", a: "" }, tracks: [] };
    const build = [{ notes: [], lines: [], open: 0, base: 0 }, { notes: [], lines: [], open: 0, base: 0 }];
    let cur = [true, false], relative = false, duet = false;
    const names = ["", ""];

    function closeLine(b) {
      if (b.notes.length === b.open) return;
      const notes = b.notes.slice(b.open);
      let end = 0;
      for (const n of notes) end = Math.max(end, n.start + n.len);
      b.lines.push({ first: b.open, count: notes.length, start: notes[0].start, end, text: notes.map((n) => n.text).join("").trimEnd() });
      b.open = b.notes.length;
    }

    for (const line of text.split(/\r?\n/)) {
      if (line[0] === "#") {
        const c = line.indexOf(":");
        if (c < 0) continue;
        const k = line.slice(1, c).trim().toUpperCase(), v = line.slice(c + 1).trim();
        if (k === "ARTIST") song.artist = v;
        else if (k === "TITLE") song.title = v;
        else if (k === "BPM") song.bpm = num(v);
        else if (k === "GAP") song.gap = num(v) / 1000;
        else if (k === "VIDEOGAP") song.videogap = num(v);
        else if (k === "START") song.start = num(v);
        else if (k === "END") song.end = num(v) / 1000;
        else if (k === "RELATIVE") relative = v.toLowerCase() === "yes";
        else if (k === "VIDEO") song.video = sources(v);
        else if (k === "P1" || k === "DUETSINGERP1") names[0] = v;
        else if (k === "P2" || k === "DUETSINGERP2") names[1] = v;
        continue;
      }
      const c = line[0];
      if (c === "E") break;
      if (c === "P") {
        const p = parseInt(line.slice(1).trim(), 10);
        build.forEach(closeLine);
        cur = [p === 1 || p === 3, p === 2 || p === 3];
        if (p >= 2) duet = true;
        continue;
      }
      if (c === "-") {
        const f = line.slice(1).trim().split(/\s+/).map((x) => parseInt(x, 10));
        build.forEach((b, i) => {
          if (!cur[i]) return;
          closeLine(b);
          if (relative) b.base += f.length > 1 && !isNaN(f[1]) ? f[1] : f[0] || 0;
        });
        continue;
      }
      const type = NOTE[c];
      if (!type) continue;
      const m = line.slice(1).match(/^\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)(?:[ \t](.*))?$/);
      if (!m) continue;
      let t = m[4] || "";
      if (t[0] === "~") t = t.slice(1); /* continues the previous syllable */
      build.forEach((b, i) => {
        if (cur[i]) b.notes.push({ type, start: +m[1] + b.base, len: +m[2], pitch: +m[3], text: t });
      });
    }
    build.forEach(closeLine);
    const n = duet && build[1].notes.length ? 2 : 1;
    for (let i = 0; i < n; i++) song.tracks.push({ name: names[i], notes: build[i].notes, lines: build[i].lines });
    if (!(song.bpm > 0) || !song.tracks[0].notes.length) return null;
    return song;
  }

  const beatTime = (s, beat) => s.gap + (beat * 60) / (s.bpm * 4);
  const timeBeat = (s, t) => ((t - s.gap) * s.bpm * 4) / 60;

  /* The line to show at time t: the one being sung, else the next one. -1 = none left. */
  function lineAt(s, track, t) {
    const b = timeBeat(s, t);
    for (let i = 0; i < track.lines.length; i++) if (b < track.lines[i].end) return i;
    return -1;
  }

  root.MbxChart = { parse, headers, sources, youtubeId, beatTime, timeBeat, lineAt };
})(typeof globalThis !== "undefined" ? globalThis : this);
