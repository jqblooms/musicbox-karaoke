/* musicbox karaoke - the songbook (a phone): pick songs for one karaoke screen. The screen's QR code
 * opens songbook.html#s=<session>; picks go into that session's queue in the live database, and
 * the screen plays them before anything else. */
"use strict";

/* this phone's screen: from the QR code, or (opened from the home screen) the last one */
const session = (() => {
  const s = (location.hash.match(/[#&]s=([A-Za-z0-9]{8,24})/) || [])[1];
  if (s) store("mbxSbSession", s);
  return s || store("mbxSbSession") || "";
})();
let fb = null, path = "", queue = new Map(), now = null, seen = 0;

let toastTimer = 0;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2500);
}

function row(s, { tag, onClick, button } = {}) {
  const r = el("div", "row");
  const img = el("img");
  img.loading = "lazy";
  img.alt = "";
  img.src = thumb(ytOf(s));
  const txt = el("div", "txt");
  const t = el("div", "t", s.title);
  if (tag) t.appendChild(el("span", "tag", tag));
  txt.append(t, el("div", "a", s.artist));
  r.append(img, txt);
  if (button) {
    const b = el("button", "mini", button.label);
    b.title = button.title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      button.run();
    });
    r.appendChild(b);
  }
  if (onClick) r.addEventListener("click", onClick);
  return r;
}

/* ------------------------------------------------------------------ picking */
const myName = () => $("name").value.trim().slice(0, 8);
$("name").value = store("mbxName") || "";
$("name").addEventListener("change", () => store("mbxName", myName()));

/* when the song on is a suggestion nobody chose (no name), ask whether to skip it for this one */
function askJump(s) {
  if (!now || now.name) return Promise.resolve(false);
  return new Promise((resolve) => {
    $("jumpText").textContent = `Nobody picked "${now.title}" - it's a suggestion. Play "${s.title}" now instead?`;
    $("jumpSheet").hidden = false;
    const done = (v) => {
      $("jumpSheet").hidden = true;
      $("jumpNow").onclick = $("jumpQueue").onclick = null;
      resolve(v);
    };
    $("jumpNow").onclick = () => done(true);
    $("jumpQueue").onclick = () => done(false);
  });
}

async function pick(s) {
  if (!fb) return toast("Not connected yet");
  const jump = await askJump(s);
  store("mbxName", myName());
  const { db, database } = fb;
  try {
    const item = { id: s.id, title: s.title.slice(0, 200), artist: s.artist.slice(0, 200), name: myName() || "Guest", by: fb.uid, at: db.serverTimestamp() };
    if (jump) item.jump = true;
    let jumped = jump;
    try {
      await db.push(db.ref(database, path + "/queue"), item);
    } catch (e) {
      if (!jump) throw e;
      /* older Firebase rules don't know "jump" yet: queue it the plain way */
      delete item.jump;
      jumped = false;
      await db.push(db.ref(database, path + "/queue"), item);
    }
    toast(jumped ? `Playing next: ${s.title}` : `Added: ${s.title}`);
    $("q").value = "";
    paintResults();
    paintBrowse();
    maybeDuet(s);
  } catch (e) {
    toast("Couldn't add it: " + e.message);
  }
}

function paintResults() {
  const q = $("q").value.trim();
  const res = q ? MbxRecommend.search(songs, q, 40).filter(ytOf) : [];
  $("results").replaceChildren(...res.map((s) => row(s, { onClick: () => pick(s), button: { label: "+", title: "Add to the queue", run: () => pick(s) } })));
  if (q && !res.length) $("results").appendChild(el("div", "empty", "No songs match"));
}
$("q").addEventListener("input", paintResults);

/* ------------------------------------------------------------------ browsing: popular, by genre */
const GENRES = [
  ["", "Popular"], ["pop", "Pop"], ["rock", "Rock"], ["dance", "Dance"], ["hiphop", "Hip-hop"], ["soul", "R&B & Soul"],
  ["schlager", "Schlager"], ["stage", "Film & Musicals"], ["country", "Country & Folk"], ["latin", "Latin"], ["asian", "Asian pop"],
];
let browseTab = store("mbxBrowse") || "", browseN = 25, browseCache = null;
/* the most viewed first, one row per song (several charts of one song: the most viewed) */
function browseSongs() {
  if (browseCache && browseCache.list === songs && browseCache.tab === browseTab) return browseCache.rows;
  const best = new Map();
  for (const s of songs) {
    if (!ytOf(s) || (browseTab && s.fam !== browseTab)) continue;
    const k = s.key;
    const b = best.get(k);
    if (!b || s.p > b.p) best.set(k, s);
  }
  const rows = [...best.values()].sort((x, y) => y.p - x.p || x.title.localeCompare(y.title));
  browseCache = { list: songs, tab: browseTab, rows };
  return rows;
}
function paintBrowse() {
  $("browse").hidden = !!$("q").value.trim();
  if ($("browse").hidden || !songs) return;
  const counts = new Map();
  for (const s of songs) if (ytOf(s)) counts.set(s.fam, (counts.get(s.fam) || 0) + 1);
  const tabs = GENRES.filter(([f]) => !f || (counts.get(f) || 0) >= 20);
  if (!tabs.some(([f]) => f === browseTab)) browseTab = "";
  $("browseTabs").replaceChildren(...tabs.map(([f, label]) => {
    const b = el("button", "btab" + (f === browseTab ? " on" : ""), label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", f === browseTab);
    b.addEventListener("click", () => {
      browseTab = f;
      browseN = 25;
      store("mbxBrowse", f);
      paintBrowse();
    });
    return b;
  }));
  const rows = browseSongs();
  $("browseList").replaceChildren(...rows.slice(0, browseN).map((s) => row(s, { onClick: () => pick(s), button: { label: "+", title: "Add to the queue", run: () => pick(s) } })));
  $("browseMore").hidden = rows.length <= browseN;
}
$("browseMore").addEventListener("click", () => {
  browseN += 25;
  paintBrowse();
});
$("q").addEventListener("input", paintBrowse);
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("results").querySelector(".row")?.click();
});

/* ------------------------------------------------------------------ what the screen is doing */
function paintQueue() {
  const items = fairOrder([...queue.values()]); /* the screen's order: turns alternate between people */
  const firstMine = items.findIndex((it) => it.by === fb.uid);
  $("queueTitle").textContent = firstMine >= 0 ? `Up next · yours is ${firstMine === 0 ? "next" : ordinal(firstMine + 1) + " in line"}` : "Up next";
  $("queue").replaceChildren(
    ...items.map((it, i) => {
      const s = songs.byId.get(it.id) || { title: it.title, artist: it.artist, v: "" };
      const mine = it.by === fb.uid;
      return row(s, {
        tag: mine ? `You · ${ordinal(i + 1)}` : it.name || null,
        button: mine
          ? { label: "×", title: "Take it out", run: () => fb.db.remove(fb.db.ref(fb.database, `${path}/queue/${it.key}`)).catch((e) => toast(e.message)) }
          : null,
      });
    })
  );
  if (!items.length) $("queue").appendChild(el("div", "empty", "Nothing picked yet. The screen plays its own suggestions until someone picks."));
}

function paintNow() {
  const s = now && songs.byId.get(now.id);
  $("nowTitle").textContent = now ? now.title : "Nothing yet";
  $("nowArtist").textContent = now ? now.artist + (now.name ? (now.name === "Chosen on the screen" ? " · chosen on the screen" : ` · picked by ${now.name}`) : " · a suggestion") : "";
  if (s) $("nowImg").src = thumb(ytOf(s));
  $("nowImg").hidden = !s;
}

let skew = 0; /* this phone's clock against the database's */
function paintHost() {
  const ok = seen && Date.now() + skew - seen < 70000;
  $("hostState").textContent = ok ? "Connected" : "Screen offline";
  $("hostState").classList.toggle("bad", !ok);
}

/* ------------------------------------------------------------------ singing along, scored here
 * The screen announces where it is in the song (play: {id, pos, playing, at}); this phone runs the
 * song's clock from that, hears its singer, and scores them (score.js). Each scored line goes to the
 * screen (singers/<this phone>), which shows a chip per singer and the results at the end. */
let play = null, chartNow = null, sing = null; /* skew (this phone vs the database clock) is kept below */

function songTime() {
  if (!play) return null;
  return play.playing ? play.pos + (Date.now() + skew - play.at) / 1000 : play.pos;
}

function askName() {
  return new Promise((resolve) => {
    $("nameAsk").value = myName();
    $("nameSheet").hidden = false;
    $("nameAsk").focus();
    const done = (v) => {
      $("nameSheet").hidden = true;
      $("nameForm").onsubmit = $("nameCancel").onclick = null;
      resolve(v);
    };
    $("nameForm").onsubmit = (e) => {
      e.preventDefault();
      const v = $("nameAsk").value.trim().slice(0, 8);
      if (!v) return;
      $("name").value = v;
      store("mbxName", v);
      publishPresence();
      done(v);
    };
    $("nameCancel").onclick = () => done("");
  });
}

/* the buttons to join in: one, or a part each for a duet */
async function paintSingButtons() {
  const box = $("singButtons");
  if (!now || sing) {
    box.hidden = true;
    return paintLyrics();
  }
  if (!chartNow || chartNow.id !== now.id) {
    const id = now.id, text = await chartText(id).catch(() => null);
    if (!now || now.id !== id) return;
    chartNow = { id, song: text && MbxChart.parse(text) };
  }
  if (!chartNow.song) {
    box.hidden = true;
    return paintLyrics();
  }
  const tr = chartNow.song.tracks;
  const mine = tr.length > 1 && duets.get(now.id);
  const parts = tr.length > 1 ? (mine === 2 ? [2, 1] : [1, 2]) : [1];
  const buttons = parts.map((part) => {
    const label = tr.length > 1 ? `${mine === part ? "Your duet: s" : "S"}ing part ${part}${tr[part - 1].name ? " (" + tr[part - 1].name + ")" : ""}` : "Sing this one";
    const b = el("button", mine && mine !== part ? "btn" : "btn blue", label);
    b.type = "button";
    b.addEventListener("click", () => startSinging(part));
    return b;
  });
  if (!lyricsOn) {
    const b = el("button", "btn", "Show lyrics");
    b.type = "button";
    b.addEventListener("click", () => {
      lyricsOn = true;
      store("mbxPhoneLyrics", true);
      paintSingButtons();
    });
    buttons.push(b);
  }
  box.replaceChildren(...buttons);
  box.hidden = false;
  paintLyrics();
}

/* ------------------------------------------------------------------ just the lyrics
 * In time with the screen, without the mic or a score: for reading along, or when the screen's
 * lyrics are off (a slow TV). Stays on from song to song until hidden; remembered on this phone. */
let lyricsOn = store("mbxPhoneLyrics") === true, view = null, viewDrawing = false;
function paintLyrics() {
  const show = lyricsOn && !sing && now && chartNow && chartNow.id === now.id && chartNow.song;
  $("lyricsPanel").hidden = !show;
  if (!show) return void (view = null);
  if (!view || view.id !== chartNow.id) view = { id: chartNow.id, song: chartNow.song, st: { alpha: 0, alphaTarget: 0 } };
  if (!viewDrawing) {
    viewDrawing = true;
    requestAnimationFrame(lyricsDraw);
  }
}
function lyricsDraw() {
  if (!view) return void (viewDrawing = false);
  requestAnimationFrame(lyricsDraw);
  const c = $("lyricsCanvas"), dpr = window.devicePixelRatio || 1;
  const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
  if (c.width !== W || c.height !== H) (c.width = W), (c.height = H);
  const ctx = c.getContext("2d"), t = songTime();
  ctx.clearRect(0, 0, W, H);
  if (t == null || !play || play.id !== view.id) return;
  /* sized so the lyrics bar fills the panel */
  const u = H / (view.song.tracks.length > 1 ? 300 : 240);
  MbxDraw.render(ctx, { song: view.song, offset: 0, t, dur: 0, W, H, u, lift: 0, notes: false, map: false, st: view.st });
}
$("lyricsHide").addEventListener("click", () => {
  lyricsOn = false;
  store("mbxPhoneLyrics", false);
  paintSingButtons();
});

async function startSinging(part) {
  if (!now || !chartNow || chartNow.id !== now.id || !chartNow.song) return;
  const name = myName() || (await askName());
  if (!name) return;
  store("mbxName", name);
  const test = /[?&]testsing=1/.test(location.search); /* the preview: no mic */
  if (!test && !MbxMic.st.on && !(await MbxMic.start())) return toast("Singing needs the mic");
  sing = { id: chartNow.id, part, name, song: chartNow.song, singer: new MbxScore.Singer(chartNow.song, part - 1, songTime() ?? -Infinity), st: { alpha: 0, alphaTarget: 0 }, buf: new Float32Array(2048), rating: "", midi: null, test };
  sing.end = MbxChart.beatTime(sing.song, Math.max(...sing.song.tracks.map((t) => t.lines.at(-1)?.end || 0)));
  sing.timer = setInterval(singTick, MbxScore.STEP * 1000);
  publishSinger(false);
  paintSing();
  requestAnimationFrame(singDraw);
  paintSingButtons();
}

function singTick() {
  if (!sing || !play || play.id !== sing.id) return;
  const t = songTime();
  if (t == null) return;
  if (t > sing.end + 1.2) return stopSinging(true); /* the singing is over: final score */
  if (!play.playing) return;
  let midi = null;
  const an = !sing.test && MbxMic.analyser();
  if (an && MbxMic.st.on && MbxMic.st.open) {
    an.getFloatTimeDomainData(sing.buf);
    const p = MbxScore.pitch(sing.buf, MbxMic.context().sampleRate);
    if (p && p.confidence > 0.75) midi = p.midi;
  }
  sing.midi = midi;
  sing.singer.add(t, midi);
  const lines = sing.singer.update(t);
  if (lines.length) {
    sing.rating = lines.at(-1).rating;
    sing.flash = performance.now();
    publishSinger(false);
    paintSing();
  }
}

function stopSinging(final) {
  if (!sing) return;
  clearInterval(sing.timer);
  if (final) {
    sing.singer.finish();
    publishSinger(true);
    toast(`${sing.name}: ${sing.singer.score.toLocaleString()} points`);
  } else if (fb) fb.db.remove(fb.db.ref(fb.database, `${path}/singers/${fb.uid}`)).catch(() => {});
  sing = null;
  paintSing();
  paintSingButtons();
}

function publishSinger(final) {
  if (!fb || !sing) return;
  const { db, database } = fb;
  db.set(db.ref(database, `${path}/singers/${fb.uid}`), {
    name: sing.name,
    part: sing.part,
    score: sing.singer.score,
    rating: sing.rating || "",
    song: sing.id,
    final: !!final,
    at: db.serverTimestamp(),
  }).catch(() => {});
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function paintSing() {
  $("singPanel").hidden = !sing;
  if (!sing) return;
  $("singWho").textContent = sing.name + (sing.song.tracks.length > 1 ? ` · part ${sing.part}` : "");
  $("singScore").textContent = sing.singer.score.toLocaleString();
  $("singRating").textContent = sing.rating || "Sing when the line comes up";
}

/* the lyrics and notes, as on the screen (draw.js), and the note being heard */
function singDraw() {
  if (!sing) return;
  requestAnimationFrame(singDraw);
  const c = $("singCanvas"), dpr = window.devicePixelRatio || 1;
  const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
  if (c.width !== W || c.height !== H) (c.width = W), (c.height = H);
  const ctx = c.getContext("2d"), t = songTime();
  ctx.clearRect(0, 0, W, H);
  if (t == null || !play || play.id !== sing.id) return;
  MbxDraw.render(ctx, { song: sing.song, offset: 0, t, dur: 0, W, H, u: H / 820, lift: 0, notes: true, map: false, st: sing.st });
  $("singNote").textContent = sing.midi == null ? "" : "♪ " + NOTE_NAMES[((Math.round(sing.midi) % 12) + 12) % 12];
  $("singRating").classList.toggle("hot", performance.now() - (sing.flash || 0) < 1200);
}

$("singStop").addEventListener("click", () => stopSinging(false));

/* ------------------------------------------------------------------ the mic */
function paintMic(st) {
  const card = $("micCard");
  card.classList.toggle("live", st.on);
  card.querySelector(".mic-badge").classList.toggle("open", st.open);
  $("micBtn").textContent = st.on ? "Stop the mic" : "Start the mic";
  $("micMeter").style.width = Math.round(st.level * 100) + "%";
  const state = $("micState");
  state.classList.toggle("warn", !!(st.error || st.feedback));
  state.textContent = st.error
    ? st.error
    : st.feedback
      ? "Squealing! Turned down - move away from the speaker, or use headphones"
      : !st.on
        ? "It works as your mic: tap Start"
        : st.hear
          ? st.open ? "You're on - singing through this phone" : "Mic on - start singing"
          : "Mic on (you won't hear yourself on this phone)";
  $("hearSw").checked = st.hear;
  $("noisySw").checked = st.noisy;
  $("micVol").disabled = !st.hear;
}
$("micBtn").addEventListener("click", () => (MbxMic.st.on ? MbxMic.stop() : MbxMic.start()));
$("hearSw").addEventListener("change", (e) => MbxMic.setHear(e.target.checked));
$("noisySw").addEventListener("change", (e) => MbxMic.setNoisy(e.target.checked));
$("micVol").value = MbxMic.st.vol;
$("micVol").addEventListener("input", (e) => MbxMic.setVol(+e.target.value));
let micPainted = 0;
MbxMic.onChange((st) => {
  const t = performance.now(); /* the meter at most 25 times a second */
  if (t - micPainted > 40 || !st.on) {
    micPainted = t;
    paintMic(st);
  }
});
paintMic(MbxMic.st);

/* ------------------------------------------------------------------ the remote
 * Every phone can go back, pause / carry on, skip, and change the volume; the screen shows who. */
function send(what) {
  if (!fb) return toast("Not connected yet");
  const { db, database } = fb;
  db.push(db.ref(database, path + "/cmd"), { do: what, name: myName() || "Guest", by: fb.uid, at: db.serverTimestamp() })
    .then(() => navigator.vibrate?.(15))
    .catch((e) => toast("Couldn't: " + e.message));
}
$("rPrev").addEventListener("click", () => send("prev"));
$("rPlay").addEventListener("click", () => send("toggle"));
$("rNext").addEventListener("click", () => send("next"));
$("rVolDown").addEventListener("click", () => send("voldown"));
$("rVolUp").addEventListener("click", () => send("volup"));
function paintRemote() {
  $("remote").hidden = !now;
  $("rPlay").innerHTML = play && play.playing === false ? "&#9654;" : "&#10074;&#10074;";
  $("rVol").textContent = play && typeof play.vol === "number" ? play.vol + "%" : "";
}

/* ------------------------------------------------------------------ lyrics size, full screen, timing */
let lyrScale = Math.max(0.7, Math.min(2, +(store("mbxLyrScale") || 1)));
function applyLyrScale() {
  $("lyricsCanvas").style.height = Math.round(150 * lyrScale) + "px";
}
function lyrSize(d) {
  lyrScale = Math.max(0.7, Math.min(2, Math.round((lyrScale + d) * 100) / 100));
  store("mbxLyrScale", lyrScale);
  applyLyrScale();
}
$("lyrSmaller").addEventListener("click", () => lyrSize(-0.15));
$("lyrBigger").addEventListener("click", () => lyrSize(0.15));
applyLyrScale();
function setFull(on) {
  $("lyricsPanel").classList.toggle("full", on);
  $("lyrFull").textContent = on ? "Exit full screen" : "Full screen";
}
$("lyrFull").addEventListener("click", () => {
  const on = !$("lyricsPanel").classList.contains("full");
  setFull(on);
  if (on) $("lyricsPanel").requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && $("lyricsPanel").classList.contains("full")) setFull(false);
});
/* the song's timing, for everyone: positive = the lyrics come sooner */
function paintNudge() {
  const n = play && now && play.id === now.id ? play.nudge || 0 : 0;
  $("nudgeVal").textContent = n === 0 ? "as charted" : `${n > 0 ? "+" : ""}${n.toFixed(1)} s`;
}
async function nudge(ms) {
  if (!fb || !now) return;
  const { db, database } = fb;
  try {
    await db.runTransaction(db.ref(database, `groups/${config.group}/nudge/${now.id}`), (v) => ({
      ms: Math.max(-5000, Math.min(5000, ((v && v.ms) || 0) + ms)),
      at: db.serverTimestamp(),
    }));
    toast(ms > 0 ? "Lyrics a little sooner - for everyone, every time" : "Lyrics a little later - for everyone, every time");
  } catch (e) {
    toast("Couldn't change it: " + e.message);
  }
}
$("nudgeSooner").addEventListener("click", () => nudge(100));
$("nudgeLater").addEventListener("click", () => nudge(-100));

/* ------------------------------------------------------------------ the home screen */
let installPrompt = null;
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
});
$("installRow").hidden = standalone || store("mbxInstallDone") === true;
$("installBtn").addEventListener("click", async () => {
  if (installPrompt) {
    installPrompt.prompt();
    const r = await installPrompt.userChoice.catch(() => null);
    if (r && r.outcome === "accepted") {
      store("mbxInstallDone", true);
      $("installRow").hidden = true;
    }
  } else toast(/iPhone|iPad|iPod/.test(navigator.userAgent) ? "Tap Share, then Add to Home Screen" : "In the browser's menu: Add to Home screen (or Install app)");
});

/* ------------------------------------------------------------------ duets
 * Phones with a name are listed (phones/<uid>); picking a duet asks who sings part 2, and they get
 * an invite. When the song comes on, each phone's own part is the button at the front. */
const phones = new Map(); /* uid -> name (other phones) */
const duets = new Map(Object.entries(store("mbxDuets") || {}).map(([k, v]) => [+k, v])); /* song id -> my part */
const saveDuets = () => store("mbxDuets", Object.fromEntries(duets));
function publishPresence() {
  if (!fb) return;
  const { db, database } = fb;
  const ref = db.ref(database, `${path}/phones/${fb.uid}`);
  const name = myName();
  if (!name) return void db.remove(ref).catch(() => {});
  db.set(ref, { name, at: db.serverTimestamp() }).catch(() => {});
  db.onDisconnect(ref).remove().catch(() => {});
}
$("name").addEventListener("change", publishPresence);
async function maybeDuet(s) {
  const text = await chartText(s.id).catch(() => null);
  const song = text && MbxChart.parse(text);
  if (!song || song.tracks.length < 2) return;
  duets.set(s.id, 1);
  saveDuets();
  if (!phones.size) return toast("It's a duet: you're part 1 - anyone can sing part 2 when it's on");
  $("duetText").textContent = `"${s.title}" has two parts - you'll sing part 1. Who should sing part 2?`;
  $("duetPeople").replaceChildren(
    ...[...phones].map(([uid, name]) => {
      const b = el("button", "btn blue", name);
      b.type = "button";
      b.addEventListener("click", () => {
        $("duetSheet").hidden = true;
        invite(uid, name, s);
      });
      return b;
    })
  );
  $("duetSheet").hidden = false;
}
$("duetNo").addEventListener("click", () => ($("duetSheet").hidden = true));
function invite(uid, name, s) {
  const { db, database } = fb;
  const ref = db.ref(database, `${path}/invites/${uid}`);
  db.set(ref, { by: fb.uid, from: myName() || "Guest", id: s.id, title: s.title.slice(0, 200), part: 2, at: Date.now() })
    .then(() => {
      toast(`Asked ${name} to sing part 2`);
      let yes = false;
      const off = db.onValue(ref, (snap) => {
        const v = snap.val();
        if (v && v.by === fb.uid && v.id === s.id) {
          if (v.accepted && !yes) {
            yes = true;
            toast(`${name} will sing part 2 with you!`);
          }
        } else {
          if (!yes) toast(`${name} said no thanks`);
          off();
        }
      });
    })
    .catch((e) => toast("Couldn't ask: " + e.message));
}
function listenInvites() {
  const { db, database } = fb;
  const ref = db.ref(database, `${path}/invites/${fb.uid}`);
  db.onValue(ref, (snap) => {
    const v = snap.val();
    if (!v || v.accepted) return;
    $("inviteText").textContent = `${v.from} wants you to sing part ${v.part} of "${v.title}" with them when it comes up.`;
    $("inviteSheet").hidden = false;
    navigator.vibrate?.(120);
    $("inviteYes").onclick = () => {
      $("inviteSheet").hidden = true;
      duets.set(v.id, v.part);
      saveDuets();
      db.set(ref, { ...v, accepted: true }).catch(() => {});
      toast(`You're part ${v.part} - your phone will say when it's on`);
      paintSingButtons();
    };
    $("inviteNo").onclick = () => {
      $("inviteSheet").hidden = true;
      db.remove(ref).catch(() => {});
    };
  });
  db.onValue(db.ref(database, `${path}/phones`), (snap) => {
    phones.clear();
    snap.forEach((c) => void (c.key !== fb.uid && c.val()?.name && phones.set(c.key, c.val().name)));
  });
}
/* the song on changed: a duet of mine starting, or one finished */
let lastNowId = 0;
function duetNow() {
  const id = now ? now.id : 0;
  if (id === lastNowId) return;
  const prev = lastNowId;
  if (prev && duets.has(prev)) {
    duets.delete(prev);
    saveDuets();
    /* the invite for it, done with */
    if (fb) fb.db.get(fb.db.ref(fb.database, `${path}/invites/${fb.uid}`)).then((s) => s.val()?.id === prev && fb.db.remove(s.ref)).catch(() => {});
  }
  lastNowId = id;
  if (id && duets.has(id)) {
    toast(`Your duet is on - tap "Sing part ${duets.get(id)}"`);
    navigator.vibrate?.([120, 80, 120]);
  }
}

/* ------------------------------------------------------------------ tonight's top singers */
function listenTonight() {
  const { db, database } = fb;
  db.onValue(db.ref(database, `${path}/scores`), (snap) => {
    const top = Object.values(snap.val() || {}).sort((a, b) => b.score - a.score).slice(0, 5);
    $("tonightSb").replaceChildren(
      ...top.map((s, i) => {
        const r = el("div", "row tonight-row");
        const txt = el("div", "txt");
        txt.append(el("div", "t", s.name), el("div", "a", s.title));
        r.append(el("b", "rank r" + (i + 1), String(i + 1)), txt, el("span", "pts", s.score.toLocaleString()));
        return r;
      })
    );
    if (!top.length) $("tonightSb").appendChild(el("div", "empty", "Nobody's been scored yet tonight. Sing along to get on here!"));
  });
}

/* ------------------------------------------------------------------ in */
window.onUnlocked = async () => {
  $("lock").hidden = true;
  $("app").hidden = false;
  if (!session) {
    $("noSession").hidden = false;
    $("session").hidden = true;
    $("hostState").textContent = "No screen";
    return;
  }
  paintBrowse();
  try {
    fb = await liveConnect();
  } catch (e) {
    $("hostState").textContent = "Offline";
    toast("Couldn't connect: " + e.message);
    return;
  }
  path = `${fb.base}/${session}`;
  const { db, database } = fb;
  const q = db.ref(database, path + "/queue");
  db.onChildAdded(q, (snap) => {
    queue.set(snap.key, { key: snap.key, ...snap.val() });
    paintQueue();
  });
  db.onChildRemoved(q, (snap) => {
    queue.delete(snap.key);
    paintQueue();
  });
  db.onValue(db.ref(database, path + "/now"), (snap) => {
    now = snap.val();
    if (sing && (!now || now.id !== sing.id)) stopSinging(true); /* the screen moved on */
    duetNow();
    paintNow();
    paintSingButtons();
    paintRemote();
  });
  db.onValue(db.ref(database, path + "/play"), (snap) => {
    play = snap.val();
    paintRemote();
    paintNudge();
  });
  publishPresence();
  listenInvites();
  listenTonight();
  /* the screen's child-friendly setting decides what this phone can find (on until it says) */
  db.onValue(db.ref(database, path + "/kids"), (snap) => {
    setKids(snap.val() !== false);
    $("kidsBadge").hidden = !kids;
    paintResults();
    paintBrowse();
    paintQueue();
  });
  db.onValue(db.ref(database, path + "/seen"), (snap) => {
    seen = snap.val() || 0;
    paintHost();
  });
  db.onValue(db.ref(database, ".info/serverTimeOffset"), (snap) => (skew = snap.val() || 0)); /* also used for the song's clock */
  setInterval(paintHost, 10000);
  paintQueue();
  paintNow();
};

start().catch((e) => {
  $("lockMsg").className = "lock-msg bad";
  $("lockMsg").textContent = "Couldn't load the songs: " + e.message;
});
