/* musicbox karaoke - the karaoke page (the host): YouTube's embedded player with our lyrics, notes
 * and word map on top (draw.js, the same as the browser extension), search, queue, autoplay and
 * recommendations, and the songbook: phones add songs through the live database (common.js). */
"use strict";

/* ------------------------------------------------------------------ state: queue, history, taste */
const st = store("mbxWeb") || {};
const mode = { queue: st.queue || [], history: st.history || [], exclude: [], upnext: [], upnextFor: -1 };
const taste = store("mbxTaste") || { artists: {} };
const settings = Object.assign({ notes: true }, store("mbxSettings") || {});
const save = () => store("mbxWeb", { queue: mode.queue, history: mode.history.slice(-300) });

let toastTimer = 0;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2500);
}

/* ------------------------------------------------------------------ the player */
let player = null, playerReady = null;
let cur = null; /* {rec, song (parsed chart), yt, offset, played, ended} */
const clock = { raw: -1, val: 0, at: 0, playing: false, out: 0 };

function loadYouTube() {
  if (playerReady) return playerReady;
  playerReady = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = resolve;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return playerReady;
}

async function playSong(rec) {
  if (kids && rec.x) {
    toast(`"${rec.title}" isn't child-friendly - skipping it`);
    if (rec.remoteKey) takeRemote(rec.remoteKey);
    mode.exclude.push(rec.id);
    return next();
  }
  leaveSong();
  const text = await chartText(rec.id);
  const song = text && MbxChart.parse(text);
  if (!song) {
    toast("That chart can't be read - skipping it");
    mode.exclude.push(rec.id);
    return next();
  }
  const yt = ytOf(rec);
  if (rec.remoteKey) takeRemote(rec.remoteKey);
  cur = { rec, song, yt, by: rec.by || "", offset: yt === rec.v ? song.videogap : 0, played: 0, ended: false, st: { alpha: 0, alphaTarget: 0 } };
  publishNow();
  if (mode.history[mode.history.length - 1] !== rec.id) mode.history.push(rec.id);
  mode.queue = mode.queue.filter((id) => id !== rec.id);
  save();
  $("welcome").hidden = true;
  $("nowTitle").textContent = rec.title;
  $("nowArtist").textContent = $("fsArtist").textContent = rec.artist + (rec.v ? "" : " · audio only");
  $("fsTitle").textContent = rec.title;
  document.title = `${rec.title} · musicbox karaoke`;
  Object.assign(clock, { raw: -1, val: 0, at: performance.now(), playing: false, out: 0 });
  await loadYouTube();
  if (!player) {
    player = new YT.Player("yt", {
      videoId: yt,
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, rel: 0, playsinline: 1, cc_load_policy: 0, origin: location.origin, mute: MUTED ? 1 : 0 },
      events: { onReady: () => applyVolume(), onStateChange, onError },
    });
  } else player.loadVideoById(yt);
  renderUpNext();
}

function onStateChange(e) {
  const s = e.data;
  clock.playing = s === YT.PlayerState.PLAYING;
  if (clock.playing) /* our lyrics replace YouTube's captions */
    for (const m of ["captions", "cc"])
      try {
        player.unloadModule(m);
      } catch {}
  clock.at = performance.now();
  $("playBtn").innerHTML = $("fsPlay").innerHTML = clock.playing ? "&#10074;&#10074;" : "&#9654;";
  $("pauseScreen").hidden = s !== YT.PlayerState.PAUSED || !cur;
  if (s === YT.PlayerState.ENDED && cur) {
    cur.ended = true;
    next();
  }
}

function onError(e) {
  /* 2 bad id, 5 HTML5 problem, 100 removed/private, 101/150 embedding not allowed (age-restricted
   * videos too), 153 player configuration */
  if (!cur) return;
  mode.exclude.push(cur.rec.id);
  const why = e.data === 101 || e.data === 150 ? "isn't allowed to play outside YouTube" : "won't play";
  toast(`${cur.rec.title} ${why} - skipping it`);
  cur.ended = true; /* not a skip of theirs */
  setTimeout(next, 1500);
}

/* YouTube reports the time a few times a second: in between, run it on from the last report */
function videoTime() {
  if (!player || !player.getCurrentTime) return 0;
  const now = performance.now(), raw = player.getCurrentTime() || 0;
  if (raw !== clock.raw) {
    clock.raw = raw;
    clock.val = raw;
    clock.at = now;
  }
  let t = clock.val + (clock.playing ? ((now - clock.at) / 1000) * (player.getPlaybackRate?.() || 1) : 0);
  t = Math.min(t, clock.val + 1);
  if (t < clock.out && clock.out - t < 0.25 && clock.playing) t = clock.out; /* no small steps back */
  if (clock.playing && cur) cur.played += Math.max(0, Math.min(0.1, t - clock.out));
  clock.out = t;
  return t;
}

/* leaving a song: did they stay with it? */
function leaveSong() {
  if (!cur) return;
  const dur = player?.getDuration?.() || 0, a = cur.rec.artist;
  if (cur.ended || (dur && cur.played > dur * 0.6)) taste.artists[a] = Math.min(3, (taste.artists[a] || 0) + 0.5);
  else if (cur.played < 30) taste.artists[a] = Math.max(-4, (taste.artists[a] || 0) - 0.75);
  store("mbxTaste", taste);
  cur = null;
}

function upNext() {
  /* phones' picks first (in the order they came), then this screen's queue, then recommendations */
  const picks = [...remote.values()]
    .sort((a, b) => a.at - b.at)
    .map((r) => songs.byId.get(r.id) && { ...MbxRecommend.info(songs, [r.id])[0], remoteKey: r.key, by: r.name })
    .filter(Boolean);
  const queued = MbxRecommend.info(songs, mode.queue).map((s) => ({ ...s, queued: true }));
  const curId = cur ? cur.rec.id : 0;
  if (mode.upnextFor !== curId || mode.upnext.length < 4) {
    mode.upnext = MbxRecommend.recommend(songs, {
      current: curId,
      history: mode.history,
      exclude: [...mode.exclude, ...mode.queue],
      taste: taste.artists,
      n: 12,
    }).map((s) => s.id);
    mode.upnextFor = curId;
  }
  const taken = new Set([...mode.queue, ...picks.map((p) => p.id)]);
  const recs = MbxRecommend.info(songs, mode.upnext.filter((id) => !taken.has(id)));
  return [...picks, ...queued, ...recs];
}

function next() {
  const list = upNext();
  if (!list.length) return toast("Nothing left to play");
  playSong(list[0]);
}

function enqueue(s) {
  if (!mode.queue.includes(s.id)) mode.queue.push(s.id);
  save();
  renderUpNext();
  toast(`Queued: ${s.title}`);
  if (!cur) playSong(s);
}

/* ------------------------------------------------------------------ lists */
function row(s, { tag, onClick, button } = {}) {
  const r = el("div", "row");
  const img = el("img");
  img.loading = "lazy";
  img.alt = "";
  img.src = thumb(ytOf(s));
  const txt = el("div", "txt");
  const t = el("div", "t", s.title);
  if (tag) t.appendChild(el("span", "tag", tag));
  txt.append(t, el("div", "a", s.artist + (s.v ? "" : " · audio only")));
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
  r.addEventListener("click", onClick);
  return r;
}

function renderUpNext() {
  const list = upNext();
  $("upnext").replaceChildren(
    ...list.map((s) =>
      row(s, {
        tag: s.remoteKey ? `\u{1F4F1} ${s.by || "Phone"}` : s.queued ? "Queued" : null,
        onClick: () => playSong(s),
        button: {
          label: "×",
          title: s.remoteKey || s.queued ? "Take it out of the queue" : "Not this one",
          run: () => {
            if (s.remoteKey) takeRemote(s.remoteKey);
            else if (s.queued) mode.queue = mode.queue.filter((id) => id !== s.id);
            else {
              mode.exclude.push(s.id);
              mode.upnext = mode.upnext.filter((id) => id !== s.id);
            }
            save();
            renderUpNext();
          },
        },
      })
    )
  );
  if (!list.length) $("upnext").appendChild(el("div", "empty", "Nothing to play next"));
}

function renderPicks() {
  const picks = MbxRecommend.recommend(songs, { current: 0, history: mode.history, exclude: mode.exclude, taste: taste.artists, n: 12 });
  $("picks").replaceChildren(
    ...picks.map((s) => {
      const p = el("div", "pick");
      const img = el("img");
      img.alt = "";
      img.src = thumb(ytOf(s));
      p.append(img, el("b", "", s.title), el("span", "", s.artist));
      p.addEventListener("click", () => playSong(s));
      return p;
    })
  );
}

/* ------------------------------------------------------------------ search */
let results = [], sel = 0;
function paintResults() {
  const box = $("results");
  box.hidden = !$("q").value.trim();
  box.replaceChildren(
    ...results.map((s, i) => {
      const r = row(s, {
        onClick: () => (closeResults(), playSong(s)),
        button: { label: "+", title: "Add to the queue", run: () => enqueue(s) },
      });
      if (i === sel) r.classList.add("sel");
      return r;
    })
  );
  if (!results.length && $("q").value.trim()) box.appendChild(el("div", "empty", "No karaoke songs match"));
}
function closeResults() {
  $("results").hidden = true;
  $("q").blur();
}
$("q").addEventListener("input", () => {
  results = MbxRecommend.search(songs, $("q").value).filter(ytOf);
  sel = 0;
  paintResults();
});
$("q").addEventListener("focus", () => $("q").value.trim() && paintResults());
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeResults();
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    sel = Math.max(0, Math.min(results.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
    paintResults();
    $("results").children[sel]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && results[sel]) {
    e.preventDefault();
    const s = results[sel];
    closeResults();
    e.shiftKey ? enqueue(s) : playSong(s);
  }
});
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest(".search")) $("results").hidden = true;
});

/* ------------------------------------------------------------------ controls */
function togglePlay() {
  if (!player || !cur) return;
  clock.playing ? player.pauseVideo() : player.playVideo();
}
$("playBtn").addEventListener("click", togglePlay);
$("nextBtn").addEventListener("click", () => cur && next());
$("shuffleBtn").addEventListener("click", () => {
  mode.upnextFor = -1;
  renderUpNext();
});
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("stage").requestFullscreen().catch(() => toast("Full screen isn't allowed here"));
}
$("fsBtn").addEventListener("click", toggleFullscreen);
$("fsExit").addEventListener("click", toggleFullscreen);
$("fsPlay").addEventListener("click", togglePlay);
$("fsNext").addEventListener("click", () => cur && next());
$("fsMute").addEventListener("click", () => $("muteBtn").click());
$("fsVol").addEventListener("input", (e) => {
  $("vol").value = e.target.value;
  $("vol").dispatchEvent(new Event("input"));
});
for (const id of ["fsBar"]) $(id).addEventListener("click", (e) => e.stopPropagation());
$("cover").addEventListener("click", togglePlay);
$("pauseScreen").addEventListener("click", togglePlay);
$("cover").addEventListener("dblclick", toggleFullscreen);

/* child-friendly: hides explicit songs everywhere, and stops one that's on */
$("kidsSw").addEventListener("change", (e) => {
  setKids(e.target.checked);
  mode.upnextFor = -1;
  renderPicks();
  renderUpNext();
  if ($("q").value.trim()) $("q").dispatchEvent(new Event("input"));
  publishKids();
  toast(kids ? "Child-friendly: on" : "Child-friendly: off");
  if (kids && cur && cur.rec.x) {
    toast(`"${cur.rec.title}" isn't child-friendly - skipping it`);
    next();
  }
});

/* volume: ours (kept between visits), applied to YouTube's player */
settings.volume ??= 80;
settings.muted ??= false;
function applyVolume() {
  $("vol").value = $("fsVol").value = settings.volume;
  $("muteBtn").innerHTML = $("fsMute").innerHTML = settings.muted || settings.volume === 0 ? "&#128263;" : "&#128266;";
  store("mbxSettings", settings);
  if (!player || !player.setVolume) return;
  player.setVolume(settings.volume);
  if (settings.muted || MUTED) player.mute();
  else player.unMute();
}
$("vol").addEventListener("input", (e) => {
  settings.volume = +e.target.value;
  settings.muted = false;
  applyVolume();
});
$("muteBtn").addEventListener("click", () => {
  settings.muted = !settings.muted;
  applyVolume();
});
applyVolume();

/* full screen: the control bar hides after 3 s without the mouse moving */
let idleTimer = 0;
function wake() {
  $("stage").classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => !$("fsBar").matches(":hover") && $("stage").classList.add("idle"), 3000);
}
$("stage").addEventListener("mousemove", wake);
$("stage").addEventListener("mousedown", wake);
document.addEventListener("fullscreenchange", () => {
  $("stage").classList.toggle("fs", document.fullscreenElement === $("stage"));
  wake();
});

/* ads: YouTube won't let a page press its Skip button, so the cover steps aside and they click it.
 * An ad is likely when the player says it's playing but the song's time doesn't move. */
let throughUntil = 0, stalledSince = 0, lastRaw = -1;
function letThrough(ms) {
  throughUntil = Math.max(throughUntil, performance.now() + ms);
}
function skipAd() {
  letThrough(20000);
  toast("Now click YouTube's Skip button");
}
$("skipAdBtn").addEventListener("click", skipAd);
$("fsSkipAd").addEventListener("click", skipAd);
setInterval(() => {
  let ad = false;
  if (player && player.getPlayerState && cur) {
    const raw = player.getCurrentTime() || 0, playing = player.getPlayerState() === YT.PlayerState.PLAYING;
    if (playing && raw === lastRaw) stalledSince ||= performance.now();
    else stalledSince = 0;
    lastRaw = raw;
    ad = stalledSince && performance.now() - stalledSince > 1500;
  }
  if (ad) letThrough(1200);
  const through = performance.now() < throughUntil;
  $("stage").classList.toggle("through", through);
  $("adPill").hidden = !ad;
}, 500);
$("notesSw").checked = settings.notes;
$("notesSw").addEventListener("change", (e) => {
  settings.notes = e.target.checked;
  store("mbxSettings", settings);
});
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === " ") (e.preventDefault(), togglePlay());
  else if (e.key === "n" || e.key === "N") cur && next();
  else if (e.key === "f" || e.key === "F") toggleFullscreen();
  else if (e.key === "m" || e.key === "M") $("muteBtn").click();
  else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    settings.volume = Math.max(0, Math.min(100, settings.volume + (e.key === "ArrowUp" ? 10 : -10)));
    settings.muted = false;
    applyVolume();
    toast(`Volume ${settings.volume}%`);
  }
  else if (e.key === "/") (e.preventDefault(), $("q").focus());
  else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && player && cur) player.seekTo(Math.max(0, videoTime() + (e.key === "ArrowLeft" ? -5 : 5)), true);
});
/* clicking the word map seeks (the strip along the bottom of the video) */
$("mapHit").addEventListener("click", (e) => {
  if (!player || !cur) return;
  const r = $("stage").getBoundingClientRect(), u = Math.max(r.height / 1080, 0.4);
  const x0 = r.left + 24 * u, w = r.width - 48 * u, dur = player.getDuration?.() || 0;
  if (dur > 0) player.seekTo(Math.max(0, Math.min(1, (e.clientX - x0) / w)) * dur, true);
});

/* ------------------------------------------------------------------ drawing */
const canvas = $("lyrics"), ctx = canvas.getContext("2d");
new ResizeObserver(() => {
  const dpr = window.devicePixelRatio || 1, r = $("stage").getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
}).observe($("stage"));

function frame() {
  requestAnimationFrame(frame);
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!cur || !player || !player.getDuration) return;
  const vt = videoTime(), dpr = window.devicePixelRatio || 1;
  MbxDraw.render(ctx, {
    song: cur.song,
    offset: cur.offset,
    t: vt - cur.offset,
    dur: player.getDuration() || 0,
    W,
    H,
    u: Math.max(H / 1080, 0.4 * dpr),
    lift: 0,
    notes: settings.notes,
    map: true,
    st: cur.st,
  });
}

/* ------------------------------------------------------------------ the songbook
 * This screen is a session in the live database; phones open songbook.html#s=<session> (the QR
 * code) and add songs to its queue. Picks from phones play before anything else. */
const remote = new Map(); /* queue key -> {key, id, name, at} */
let session = store("mbxSession") || newSessionId();
store("mbxSession", session);
let hosted = null; /* {fb, path} once connected */
/* everything a phone needs, in the QR code: this screen's session and the key to the songs */
const songbookUrl = () => new URL(`songbook.html#s=${session}&k=${b64url.enc(keyBytes)}`, location.href).href;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("couldn't load " + src));
    document.head.appendChild(s);
  });
}

async function showQr() {
  await loadScript("https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js");
  const q = qrcode(0, "M");
  q.addData(songbookUrl());
  q.make();
  const src = q.createDataURL(6, 2);
  $("qr").src = $("fsQr").src = src;
  $("qrLink").href = songbookUrl();
}

async function hostSongbook() {
  try {
    const fb = await liveConnect();
    const { db, database } = fb;
    let path = `${fb.base}/${session}`;
    try {
      await db.set(db.ref(database, path + "/host"), fb.uid);
    } catch {
      /* this browser lost its sign-in, so the old session isn't ours any more: start a new one */
      session = newSessionId();
      store("mbxSession", session);
      path = `${fb.base}/${session}`;
      await db.set(db.ref(database, path + "/host"), fb.uid);
    }
    hosted = { fb, path };
    const beat = () => db.set(db.ref(database, path + "/seen"), db.serverTimestamp()).catch(() => {});
    beat();
    setInterval(beat, 20000);
    const queue = db.ref(database, path + "/queue");
    db.onChildAdded(queue, (snap) => {
      const v = snap.val();
      if (!v || !songs.byId.has(v.id)) {
        if (v && kids && songsAll.byId.get(v.id)?.x) toast(`${v.name || "Someone"} picked "${v.title}" - not child-friendly, left out`);
        return void db.remove(snap.ref).catch(() => {});
      }
      remote.set(snap.key, { key: snap.key, id: v.id, name: v.name || "", at: v.at || 0 });
      renderUpNext();
      if (!cur) next();
      else toast(`${v.name || "Someone"} added ${songs.byId.get(v.id).title}`);
    });
    db.onChildRemoved(queue, (snap) => {
      remote.delete(snap.key);
      renderUpNext();
    });
    await showQr();
    $("sbStatus").textContent = "Scan to pick songs on your phone";
    publishKids();
    publishNow();
  } catch (e) {
    $("sbStatus").textContent = "Songbook offline: " + e.message;
  }
}

function takeRemote(key) {
  remote.delete(key);
  if (hosted) hosted.fb.db.remove(hosted.fb.db.ref(hosted.fb.database, `${hosted.path}/queue/${key}`)).catch(() => {});
}

function publishKids() {
  if (!hosted) return;
  const { db, database } = hosted.fb;
  db.set(db.ref(database, hosted.path + "/kids"), kids).catch(() => {});
}

function publishNow() {
  if (!hosted || !cur) return;
  const { db, database } = hosted.fb;
  db.set(db.ref(database, hosted.path + "/now"), { id: cur.rec.id, title: cur.rec.title, artist: cur.rec.artist, name: cur.by || "", at: db.serverTimestamp() }).catch(() => {});
}

/* ------------------------------------------------------------------ in */
window.onUnlocked = enter;
function enter() {
  $("lock").hidden = true;
  $("app").hidden = false;
  renderPicks();
  renderUpNext();
  requestAnimationFrame(frame);
  loadYouTube();
  hostSongbook();
}
window.addEventListener("pagehide", leaveSong);
start().catch((e) => {
  $("lockMsg").className = "lock-msg bad";
  $("lockMsg").textContent = "Couldn't load the songs: " + e.message;
});
