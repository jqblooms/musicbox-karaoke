/* musicbox lyrics - searching our songs and recommending what to sing next. Shared by the
 * extension's background worker and the karaoke web page.
 *
 * Songs: [{id, artist, title, language, year, genre, v, a}] (no chart texts). */
(function (root) {
  "use strict";

  function words(s) {
    return (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9Ѐ-ӿ぀-ヿ一-鿿]+/g, " ")
      .trim();
  }

  /* genres into broad families, so "heavy metal", "grunge" and "tanzmetal" all count as rock */
  const FAMILIES = [
    ["rock", /rock|metal|punk|grunge|indie|alternative|britpop|emo|hardcore|garage|psychedelic|ska/],
    ["schlager", /schlager|volks|chanson|neue deutsche welle|ndw|liedermacher/],
    ["stage", /soundtrack|musical|disney|film|movie|anime|game|theme|tv/],
    ["hiphop", /hip.?hop|rap|trap|grime/],
    ["soul", /r&b|rnb|soul|funk|motown|gospel|jazz|blues|swing/],
    ["dance", /dance|electro|edm|house|techno|trance|disco|eurodance|club|dubstep|hands ?up/],
    ["country", /country|folk|bluegrass|americana/],
    ["asian", /j-?pop|k-?pop|c-?pop|j-?rock|vocaloid|enka|mandopop|cantopop/],
    ["latin", /latin|reggaeton|salsa|bachata|samba|flamenco|reggae/],
    ["pop", /pop|ballad|singer|chart/],
  ];
  function family(g) {
    if (!g) return "";
    for (const [f, re] of FAMILIES) if (re.test(g)) return f;
    return g;
  }

  /* Sort, index and fill in what the recommendations need. Returns the same array. */
  function prepare(list) {
    for (const s of list) {
      s.key = words(s.artist + " " + s.title);
      s.language = (s.language || "").toLowerCase();
      s.genre = (s.genre || "").toLowerCase();
    }
    list.sort((x, y) => (x.artist + x.title).localeCompare(y.artist + y.title));
    list.byId = new Map(list.map((s) => [s.id, s]));
    /* half the charts name no genre: a song without one takes its artist's most common genre */
    const byArtist = new Map();
    for (const s of list)
      if (s.genre) {
        const m = byArtist.get(s.artist) || new Map();
        m.set(s.genre, (m.get(s.genre) || 0) + 1);
        byArtist.set(s.artist, m);
      }
    for (const s of list) {
      let g = s.genre;
      if (!g && byArtist.has(s.artist)) g = [...byArtist.get(s.artist)].sort((a, b) => b[1] - a[1])[0][0];
      s.g = g || "";
      s.fam = family(s.g);
    }
    return list;
  }

  const plain = ({ key, g, fam, ...s }) => s;

  /* Songs whose artist and title hold every word typed; titles and artists that start with what
   * was typed come first, music videos before audio-only uploads. */
  function search(list, q, n = 60) {
    const terms = words(q).split(" ").filter(Boolean);
    if (!terms.length) return [];
    const first = terms.join(" ");
    const hits = [];
    for (const s of list) {
      if (!terms.every((t) => s.key.includes(t))) continue;
      const t = words(s.title), a = words(s.artist);
      let rank = 0;
      if (t === first || a === first) rank -= 4;
      if (t.startsWith(first)) rank -= 3;
      if (a.startsWith(first)) rank -= 2;
      if (!s.v) rank += 1;
      hits.push([rank, s]);
      if (hits.length >= 2000) break;
    }
    hits.sort((x, y) => x[0] - y[0]);
    return hits.slice(0, n).map((h) => plain(h[1]));
  }

  /* What to sing next. A song scores for being like the one just sung (the same language above
   * all, the same genre or family, a similar year, sometimes the same artist), for artists the
   * singers stay with (sung to the end) and against ones they skip, a little for having a real
   * music video, plus some chance so it does not repeat itself. Anything sung recently, queued or
   * turned down is left out, and the list has one song per artist. */
  function score(c, cur, taste, recent, sessionArtists) {
    let sc = Math.random() * 1.6;
    if (cur) {
      if (cur.language && c.language) sc += c.language === cur.language ? 2.5 : -5;
      if (c.artist === cur.artist) sc += recent.slice(-2).every((a) => a === cur.artist) ? -6 : 1.2;
      if (cur.g && c.g) sc += c.g === cur.g ? 3 : c.fam === cur.fam ? 1.8 : -2;
      if (cur.year && c.year) sc += 1.6 * Math.max(0, 1 - Math.abs(cur.year - c.year) / 12);
    }
    const t = (taste && taste[c.artist]) || 0;
    sc += Math.max(-4, Math.min(3, t));
    if (sessionArtists.has(c.artist)) sc += 0.4;
    if (c.v) sc += 0.8;
    return sc;
  }

  function recommend(list, { current, history = [], exclude = [], taste = {}, n = 8 }) {
    const cur = list.byId.get(current);
    const skip = new Set([...history.slice(-200), ...exclude, current]);
    const recentArtists = history.map((id) => list.byId.get(id)?.artist).filter(Boolean);
    const sessionArtists = new Set(recentArtists);
    const scored = [];
    for (const c of list) {
      if (skip.has(c.id) || !(c.v || c.a)) continue;
      scored.push([score(c, cur, taste, recentArtists, sessionArtists), c]);
    }
    scored.sort((x, y) => y[0] - x[0]);
    const out = [], artists = new Set();
    for (const [, c] of scored) {
      if (artists.has(c.artist)) continue;
      artists.add(c.artist);
      out.push(plain(c));
      if (out.length >= n) break;
    }
    return out;
  }

  function info(list, ids) {
    return ids.map((id) => list.byId.get(id)).filter(Boolean).map(plain);
  }

  root.MbxRecommend = { prepare, search, recommend, info, words };
})(typeof globalThis !== "undefined" ? globalThis : this);
