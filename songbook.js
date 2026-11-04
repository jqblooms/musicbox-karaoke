/* musicbox karaoke - the songbook (a phone): pick songs for one karaoke screen. The screen's QR code
 * opens songbook.html#s=<session>; picks go into that session's queue in the live database, and
 * the screen plays them before anything else. */
"use strict";

const session = (location.hash.match(/[#&]s=([A-Za-z0-9]{8,24})/) || [])[1] || "";
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

async function pick(s) {
  if (!fb) return toast("Not connected yet");
  store("mbxName", myName());
  const { db, database } = fb;
  try {
    await db.push(db.ref(database, path + "/queue"), { id: s.id, title: s.title.slice(0, 200), artist: s.artist.slice(0, 200), name: myName() || "Guest", by: fb.uid, at: db.serverTimestamp() });
    toast(`Added: ${s.title}`);
    $("q").value = "";
    paintResults();
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
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("results").querySelector(".row")?.click();
});

/* ------------------------------------------------------------------ what the screen is doing */
function paintQueue() {
  const items = [...queue.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
  $("queue").replaceChildren(
    ...items.map((it) => {
      const s = songs.byId.get(it.id) || { title: it.title, artist: it.artist, v: "" };
      const mine = it.by === fb.uid;
      return row(s, {
        tag: mine ? "You" : it.name || null,
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
  $("nowArtist").textContent = now ? now.artist + (now.name ? ` · picked by ${now.name}` : "") : "";
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
    return;
  }
  if (!chartNow || chartNow.id !== now.id) {
    const id = now.id, text = await chartText(id).catch(() => null);
    if (!now || now.id !== id) return;
    chartNow = { id, song: text && MbxChart.parse(text) };
  }
  if (!chartNow.song) return void (box.hidden = true);
  const tr = chartNow.song.tracks;
  box.replaceChildren(
    ...(tr.length > 1 ? [1, 2] : [1]).map((part) => {
      const b = el("button", "btn blue", tr.length > 1 ? `Sing part ${part}${tr[part - 1].name ? " (" + tr[part - 1].name + ")" : ""}` : "Sing this one");
      b.type = "button";
      b.addEventListener("click", () => startSinging(part));
      return b;
    })
  );
  box.hidden = false;
}

async function startSinging(part) {
  if (!now || !chartNow || chartNow.id !== now.id || !chartNow.song) return;
  const name = myName() || (await askName());
  if (!name) return;
  store("mbxName", name);
  const test = /[?&]testsing=1/.test(location.search); /* the preview: no mic */
  if (!test && !MbxMic.st.on && !(await MbxMic.start())) return toast("Singing needs the mic");
  sing = { id: chartNow.id, part, name, song: chartNow.song, singer: new MbxScore.Singer(chartNow.song, part - 1), st: { alpha: 0, alphaTarget: 0 }, buf: new Float32Array(2048), rating: "", midi: null, test };
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
    paintNow();
    paintSingButtons();
  });
  db.onValue(db.ref(database, path + "/play"), (snap) => {
    play = snap.val();
  });
  /* the screen's child-friendly setting decides what this phone can find (on until it says) */
  db.onValue(db.ref(database, path + "/kids"), (snap) => {
    setKids(snap.val() !== false);
    $("kidsBadge").hidden = !kids;
    paintResults();
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
