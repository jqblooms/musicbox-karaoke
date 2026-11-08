/* musicbox karaoke - the karaoke page (the host): YouTube's embedded player with our lyrics, notes
 * and word map on top (draw.js, the same as the browser extension), search, queue, autoplay and
 * recommendations, and the songbook: phones add songs through the live database (common.js). */
"use strict";

const TV = new URLSearchParams(location.search).get("tv") === "1"; /* TV mode (the TV app) */

/* ------------------------------------------------------------------ state: queue, history, taste */
const st = store("mbxWeb") || {};
const mode = { queue: st.queue || [], history: st.history || [], exclude: [], upnext: [], upnextFor: -1 };
const taste = store("mbxTaste") || { artists: {} };
const settings = Object.assign({ notes: true, lyrics: true }, store("mbxSettings") || {});
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

/* the loading card: from the moment a song is chosen until it's really playing */
let loadingSince = 0;
function showLoading(rec, state) {
  $("loadTitle").textContent = rec.title;
  $("loadArtist").textContent = rec.artist;
  $("loadState").textContent = state;
  $("loadCard").hidden = false;
  if (!loadingSince) loadingSince = performance.now();
}
function hideLoading() {
  $("loadCard").hidden = true;
  loadingSince = 0;
}

async function playSong(rec) {
  showLoading(rec, "Loading…");
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
    hideLoading();
    toast("That chart can't be read - skipping it");
    mode.exclude.push(rec.id);
    return next();
  }
  const yt = ytOf(rec);
  if (rec.remoteKey) takeRemote(rec.remoteKey);
  showLoading(rec, "Starting the video…");
  /* auto: an algorithm's suggestion nobody chose - a phone's pick may jump in over it */
  cur = { rec, song, yt, by: rec.by || "", auto: !!rec.auto, offset: yt === rec.v ? song.videogap : 0, played: 0, ended: false, st: { alpha: 0, alphaTarget: 0 } };
  publishNow();
  publishPlay();
  if (hosted) hosted.fb.db.remove(hosted.fb.db.ref(hosted.fb.database, hosted.path + "/singers")).catch(() => {});
  singers.clear();
  paintChips();
  if (mode.history[mode.history.length - 1] !== rec.id) mode.history.push(rec.id);
  mode.queue = mode.queue.filter((id) => id !== rec.id);
  save();
  $("welcome").hidden = true;
  document.body.classList.remove("idle-screen");
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
  if (clock.playing) hideLoading();
  publishPlay();
  if (s === YT.PlayerState.ENDED) endSong();
}

/* the song is over: the results if anyone sang, then the next one */
function endSong() {
  if (!cur || cur.ended) return;
  cur.ended = true;
  const rec = cur.rec;
  (singersNow().length ? showResults(rec) : Promise.resolve()).finally(() => cur && cur.rec === rec && next());
}

/* Some videos never say they've ended (YouTube's spinner sits on the last frame), and some never
 * start: within a second of the end and not moving counts as the end, and a song that hasn't
 * started after 25 s is skipped. */
let stillAtEnd = 0;
setInterval(() => {
  if (!cur || !player || !player.getDuration) return;
  if (loadingSince && performance.now() - loadingSince > 25000 && !cur.ended) {
    hideLoading();
    toast(`"${cur.rec.title}" won't start - skipping it`);
    mode.exclude.push(cur.rec.id);
    cur.ended = true;
    return next();
  }
  const d = player.getDuration() || 0, t = player.getCurrentTime() || 0;
  stillAtEnd = d > 0 && d - t < 1.2 && !clock.playing ? stillAtEnd + 1 : 0;
  if (stillAtEnd >= 2) endSong();
}, 1000);

function onError(e) {
  /* 2 bad id, 5 HTML5 problem, 100 removed/private, 101/150 embedding not allowed (age-restricted
   * videos too), 153 player configuration */
  if (!cur) return;
  hideLoading();
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
  return [...picks, ...queued, ...recs.map((s) => ({ ...s, auto: true }))];
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
  if (TV) paintTvSettings();
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
/* lyrics off: nothing drawn over the video (on a slow TV, phones can show them instead) */
$("lyricsSw").checked = settings.lyrics;
$("lyricsSw").addEventListener("change", (e) => {
  settings.lyrics = e.target.checked;
  store("mbxSettings", settings);
});
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
/* the glass panels behind the lyrics, on their own canvas: drawn once, faded with CSS opacity */
const bgCanvas = $("lyricsBg"), bg = { ctx: bgCanvas.getContext("2d"), state: { key: "" } };
let bgAlpha = 0;
function setBgAlpha(a) {
  if (Math.abs(a - bgAlpha) < 0.004 && !(a === 0 && bgAlpha !== 0)) return;
  bgAlpha = a;
  bgCanvas.style.opacity = a.toFixed(3);
}
/* The lyrics are drawn at no more than 1280 x 720 on a TV (1920 wide elsewhere) and scaled up by the
 * screen: a 4K TV would otherwise redraw 8 million pixels a frame on a weak chip, over the video. */
let drawScale = 1;
/* Levels (the width the lyrics are drawn at, and how often): if the screen keeps missing frames,
 * the lyrics step down a level (on a TV: 60 a second, then 30, then 540p, then 360p); after a
 * couple of minutes running smoothly they try a level up again. The level that works is
 * remembered on this device. */
const LEVELS = TV
  ? [{ w: 1280, fps: 60 }, { w: 1280, fps: 30 }, { w: 960, fps: 30 }, { w: 640, fps: 30 }]
  : [1920, 1280, 960, 640].map((w) => ({ w, fps: 60 }));
let level = Math.min(LEVELS.length - 1, Math.max(0, +(store("mbxLyricsLevel3") ?? 0) || 0));
function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1, r = $("stage").getBoundingClientRect();
  drawScale = Math.min(dpr, LEVELS[level].w / Math.max(1, r.width));
  canvas.width = bgCanvas.width = Math.max(1, Math.round(r.width * drawScale));
  canvas.height = bgCanvas.height = Math.max(1, Math.round(r.height * drawScale));
  bg.state.key = "";
  lastSig = "";
}
new ResizeObserver(sizeCanvas).observe($("stage"));

/* watching for lag: of the screen's frames over 5 s (while a song plays), how many came late - over
 * twice the screen's normal frame time, learnt as it goes (TVs can run at 60, 50, 30 or 24 Hz) */
const lag = { last: 0, n: 0, late: 0, since: 0, calm: 0, triedUpAt: 0, noUp: false, base: 1000, gaps: [] };
function watchLag(now) {
  const playing = cur && clock.playing && document.visibilityState === "visible";
  const gap = now - lag.last;
  lag.last = now;
  if (!playing || gap > 1000) return void ((lag.n = lag.late = 0), (lag.since = now));
  lag.n++;
  lag.gaps.push(gap);
  if (gap > Math.max(lag.base * 1.9, 20)) lag.late++;
  if (now - lag.since < 5000) return;
  /* the screen's normal frame time: the quickest typical (median) seen so far */
  const sorted = lag.gaps.sort((a, b) => a - b), median = sorted[sorted.length >> 1] || lag.base;
  const first = lag.base === 1000;
  lag.base = Math.max(8, Math.min(lag.base, median));
  lag.gaps = [];
  const share = first ? 0 : lag.late / Math.max(1, lag.n); /* the first window only learns the rhythm */
  lag.n = lag.late = 0;
  lag.since = now;
  if (share > 0.2 && level < LEVELS.length - 1) {
    if (now - lag.triedUpAt < 30000) lag.noUp = true; /* the sharper level didn't hold: stay put */
    level++;
    lag.calm = 0;
    store("mbxLyricsLevel3", level);
    sizeCanvas();
    console.debug(`[musicbox] lag (${Math.round(share * 100)}% late frames): lyrics now drawn ${canvas.width}x${canvas.height}`);
  } else if (share < 0.03) {
    lag.calm += 5;
    if (lag.calm >= 120 && level > 0 && !lag.noUp) { /* two smooth minutes: try a level sharper */
      level--;
      lag.calm = 0;
      lag.triedUpAt = now;
      store("mbxLyricsLevel3", level);
      sizeCanvas();
    }
  } else lag.calm = 0;
}

/* drawn every frame on a computer, 30 times a second on a TV, and not at all when nothing changed */
let lastDraw = 0, lastSig = "";
function frame(now) {
  requestAnimationFrame(frame);
  watchLag(now);
  /* at 30 a second: every other screen frame (a little early is fine - waiting for a whole 33 ms
   * would sometimes skip two frames, which shows as a stutter) */
  if (LEVELS[level].fps < 60 && now - lastDraw < 1000 / LEVELS[level].fps - 8) return;
  const W = canvas.width, H = canvas.height;
  if (!cur || !player || !player.getDuration || !settings.lyrics) {
    if (lastSig !== "empty") ctx.clearRect(0, 0, W, H), (lastSig = "empty");
    setBgAlpha(0);
    return;
  }
  const vt = videoTime();
  const sig = [vt.toFixed(3), W, H, settings.notes, cur.rec.id, cur.st.alpha.toFixed(3)].join("|");
  if (sig === lastSig) return;
  lastSig = sig;
  lastDraw = now;
  const t0 = performance.now();
  ctx.clearRect(0, 0, W, H);
  MbxDraw.render(ctx, {
    song: cur.song,
    offset: cur.offset,
    t: vt - cur.offset,
    dur: player.getDuration() || 0,
    W,
    H,
    u: Math.max(H / 1080, 0.4 * drawScale),
    lift: 0,
    notes: settings.notes,
    map: true,
    st: cur.st,
    bg,
  });
  setBgAlpha(cur.st.alpha);
  frameStat(performance.now() - t0);
}

/* timing, for "why does it lag?": a line in the console every 10 s (Verbose level) */
const fstat = { n: 0, ms: 0, worst: 0, since: performance.now() };
function frameStat(ms) {
  fstat.n++;
  fstat.ms += Math.max(0, ms);
  fstat.worst = Math.max(fstat.worst, ms);
  if (performance.now() - fstat.since > 10000) {
    console.debug(`[musicbox] ${fstat.n} lyric frames in 10 s, avg ${(fstat.ms / fstat.n).toFixed(1)} ms, worst ${fstat.worst.toFixed(1)} ms, canvas ${canvas.width}x${canvas.height}`);
    Object.assign(fstat, { n: 0, ms: 0, worst: 0, since: performance.now() });
  }
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
  if (TV) $("tvQr").hidden = false;
  await loadScript("https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js");
  const q = qrcode(0, "M");
  q.addData(songbookUrl());
  q.make();
  const src = q.createDataURL(6, 2);
  $("qr").src = $("fsQr").src = $("tvQrImg").src = src;
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
      else if (v.jump && cur.auto && !cur.ended) { /* they chose to skip the suggestion that's on */
        toast(`${v.name || "Someone"} skipped the suggestion: ${songs.byId.get(v.id).title}`);
        cur.ended = true;
        next();
      } else toast(`${v.name || "Someone"} added ${songs.byId.get(v.id).title}`);
    });
    db.onChildRemoved(queue, (snap) => {
      remote.delete(snap.key);
      renderUpNext();
    });
    await showQr();
    $("sbStatus").textContent = "Scan to pick songs on your phone";
    publishKids();
    publishNow();
    publishPlay();
    listenSingers(fb, path);
  } catch (e) {
    $("sbStatus").textContent = "Songbook offline: " + e.message;
  }
}

function takeRemote(key) {
  remote.delete(key);
  if (hosted) hosted.fb.db.remove(hosted.fb.db.ref(hosted.fb.database, `${hosted.path}/queue/${key}`)).catch(() => {});
}

/* where the song is (in song time), for the phones that score their singers */
function publishPlay() {
  if (!hosted || !cur || !player || !player.getCurrentTime) return;
  const { db, database } = hosted.fb;
  db.set(db.ref(database, hosted.path + "/play"), {
    id: cur.rec.id,
    pos: Math.max(0, videoTime() - cur.offset),
    playing: !!clock.playing,
    at: db.serverTimestamp(),
  }).catch(() => {});
}
setInterval(() => clock.playing && publishPlay(), 3000);

/* ------------------------------------------------------------------ singers (phones scoring themselves) */
const singers = new Map(); /* uid -> {name, part, score, rating, song, final} */
function singersNow() {
  return cur ? [...singers.values()].filter((s) => s.song === cur.rec.id) : [];
}
function paintChips() {
  const list = singersNow().sort((a, b) => (a.part || 1) - (b.part || 1) || b.score - a.score);
  $("chips").replaceChildren(
    ...list.map((s) => {
      const c = el("div", "chip" + (s.part === 2 ? " p2" : ""));
      const who = el("div", "who");
      who.append(el("span", "", s.name), el("small", "", (cur.song.tracks.length > 1 ? `Part ${s.part || 1} · ` : "") + (s.rating || "singing")));
      c.append(el("span", "dot"), who, el("span", "pts", (s.score || 0).toLocaleString()));
      return c;
    })
  );
}
function listenSingers(fb, path) {
  fb.db.onValue(fb.db.ref(fb.database, path + "/singers"), (snap) => {
    singers.clear();
    snap.forEach((c) => void singers.set(c.key, c.val() || {}));
    paintChips();
  });
}

const stars = (score) => "★".repeat(Math.round(score / 2000)) + "☆".repeat(5 - Math.round(score / 2000));

/* after a song with singers: their scores, and the song's best three (kept for good: names of up to
 * eight letters), for a few seconds before the next song */
async function showResults(rec) {
  await new Promise((r) => setTimeout(r, 2500)); /* the phones send their last lines */
  const done = [...singers.values()].filter((s) => s.song === rec.id && s.score > 0).sort((a, b) => b.score - a.score);
  if (!done.length) return;
  $("resTitle").textContent = rec.title;
  $("resSingers").replaceChildren(
    ...done.map((s) => {
      const r = el("div", "res-row");
      r.append(el("span", "name", s.name), el("span", "stars", stars(s.score)), el("span", "num", s.score.toLocaleString()));
      return r;
    })
  );
  let board = [];
  const fresh = new Set();
  if (hosted) {
    const { db, database } = hosted.fb;
    const ref = db.ref(database, `groups/${config.group}/board/${rec.id}`);
    try {
      const res = await db.runTransaction(ref, (cur0) => {
        const all = [...Object.values(cur0 || {})];
        for (const s of done) all.push({ name: String(s.name).slice(0, 8), score: Math.min(10000, Math.max(0, Math.round(s.score))), at: Date.now() });
        all.sort((a, b) => b.score - a.score || a.at - b.at);
        return Object.fromEntries(all.slice(0, 3).map((e, i) => [String(i), e]));
      });
      board = Object.values(res.snapshot.val() || {});
      const now = Date.now();
      board.forEach((e, i) => now - e.at < 60000 && fresh.add(i));
    } catch {
      board = [];
    }
  }
  $("resBoard").replaceChildren(
    ...(board.length
      ? board.map((e, i) => {
          const r = el("div", "res-row");
          r.append(el("span", "name", `${i + 1}. ${e.name}`));
          if (fresh.has(i)) r.append(el("span", "new", "New!"));
          r.append(el("span", "stars", stars(e.score)), el("span", "num", e.score.toLocaleString()));
          return r;
        })
      : [Object.assign(el("div", "res-row empty"), { textContent: "No scores kept yet" })])
  );
  $("scoreScreen").hidden = false;
  await new Promise((r) => setTimeout(r, 9000));
  $("scoreScreen").hidden = true;
}

function publishKids() {
  if (!hosted) return;
  const { db, database } = hosted.fb;
  db.set(db.ref(database, hosted.path + "/kids"), kids).catch(() => {});
}

function publishNow() {
  if (!hosted || !cur) return;
  const { db, database } = hosted.fb;
  db.set(db.ref(database, hosted.path + "/now"), { id: cur.rec.id, title: cur.rec.title, artist: cur.rec.artist, name: cur.by || (cur.auto ? "" : "Chosen on the screen").slice(0, 40), at: db.serverTimestamp() }).catch(() => {});
}

/* ------------------------------------------------------------------ TV mode (?tv=1)
 * The page in the TV app: the video fills the screen, the QR code stays up, and the remote drives
 * it: OK pauses, Left / Right jump 10 s, Down opens Up next, Up opens the menu, Back closes what's
 * open (the app sends Escape for Back). Media keys work too. */
let hintTimer = 0;
function tvHint() {
  if (!TV) return;
  $("tvHint").hidden = false;
  $("tvHint").style.opacity = "1";
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => ($("tvHint").style.opacity = "0"), 4000);
}
function tvPanel() {
  if (!$("tvMenu").hidden) return "menu";
  if (document.querySelector(".side").classList.contains("open")) return "side";
  return null;
}
function tvClose() {
  $("tvMenu").hidden = true;
  document.querySelector(".side").classList.remove("open");
  document.activeElement?.blur();
}
function tvFocusables(panel) {
  if (panel === "menu") return [...document.querySelectorAll("#tvMenu .tv-item")];
  return [...document.querySelectorAll("#upnext .row")];
}
function tvOpen(panel) {
  tvClose();
  if (panel === "menu") {
    paintTvMenu();
    $("tvMenu").hidden = false;
  } else {
    renderUpNext();
    document.querySelector(".side").classList.add("open");
  }
  const items = tvFocusables(panel);
  items.forEach((el) => (el.tabIndex = 0));
  items[0]?.focus();
}
function paintTvMenu() {
  $("tvKids").textContent = `Child-friendly: ${kids ? "On" : "Off"}`;
  $("tvLyrics").textContent = `Lyrics: ${settings.lyrics ? "On" : "Off (on phones)"}`;
  $("tvNotes").textContent = `Note bars: ${settings.notes ? "On" : "Off"}`;
}
function moveFocus(items, step) {
  const i = items.indexOf(document.activeElement);
  const n = Math.max(0, Math.min(items.length - 1, (i < 0 ? 0 : i + step)));
  items[n]?.focus();
  items[n]?.scrollIntoView({ block: "nearest" });
}
/* the welcome screen's picks: a grid, moved through by the arrows */
function moveGrid(key) {
  const picks = [...document.querySelectorAll(".pick")], chips = [...document.querySelectorAll(".tv-chip")];
  [...picks, ...chips].forEach((p) => (p.tabIndex = 0));
  /* the settings row above the songs */
  const c = chips.indexOf(document.activeElement);
  if (c >= 0) {
    if (key === "ArrowLeft" || key === "ArrowRight") chips[Math.max(0, Math.min(chips.length - 1, c + (key === "ArrowRight" ? 1 : -1)))].focus();
    else if (key === "ArrowDown") picks[0]?.focus();
    return;
  }
  let i = picks.indexOf(document.activeElement);
  if (i < 0) return picks[0]?.focus();
  const cols = Math.max(1, picks.filter((p) => p.offsetTop === picks[0].offsetTop).length);
  if (key === "ArrowUp" && i < cols) return chips[0]?.focus(); /* up from the top row: the settings */
  i += key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : key === "ArrowDown" ? cols : -cols;
  if (picks[i]) picks[i].focus();
}
function paintTvSettings() {
  $("tvSetKids").textContent = `Child-friendly: ${kids ? "On" : "Off"}`;
  $("tvSetLyrics").textContent = `Lyrics: ${settings.lyrics ? "On" : "Off"}`;
  $("tvSetNotes").textContent = `Note bars: ${settings.notes ? "On" : "Off"}`;
}
if (TV) {
  document.body.classList.add("tv");
  document.querySelector(".welcome p").textContent = "Choose one with the remote, or scan the code with your phone to pick any song:";
  document.querySelector(".pause-card span").textContent = "Press OK to carry on";
  $("tvSettings").hidden = false;
  $("tvSetKids").addEventListener("click", () => {
    $("kidsSw").click();
    paintTvSettings();
    $("tvSetKids").focus(); /* stay on the switch after the songs are refreshed */
  });
  $("tvSetLyrics").addEventListener("click", () => {
    $("lyricsSw").click();
    paintTvSettings();
    $("tvSetLyrics").focus();
  });
  $("tvSetNotes").addEventListener("click", () => {
    $("notesSw").click();
    paintTvSettings();
    $("tvSetNotes").focus(); /* stay on the switch after the songs are refreshed */
  });
  $("tvKids").addEventListener("click", () => {
    $("kidsSw").click();
    paintTvMenu();
  });
  $("tvLyrics").addEventListener("click", () => {
    $("lyricsSw").click();
    paintTvMenu();
  });
  $("tvNotes").addEventListener("click", () => {
    $("notesSw").click();
    paintTvMenu();
  });
  $("tvNext").addEventListener("click", () => {
    tvClose();
    next();
  });
  $("tvUpnext").addEventListener("click", () => tvOpen("side"));
  document.addEventListener(
    "keydown",
    (e) => {
      const k = e.key, panel = tvPanel();
      const handled = () => (e.preventDefault(), e.stopImmediatePropagation());
      tvHint();
      if (k === "Escape" || k === "GoBack" || k === "BrowserBack" || k === "Backspace") {
        if (panel) tvClose();
        return handled();
      }
      if (k === "MediaPlayPause" || k === "MediaPlay" || k === "MediaPause") return handled(), togglePlay();
      if (k === "MediaTrackNext" || k === "MediaFastForward") return handled(), cur && next();
      if (panel) {
        if (k === "ArrowDown" || k === "ArrowUp") moveFocus(tvFocusables(panel), k === "ArrowDown" ? 1 : -1);
        else if (k === "ArrowLeft" && panel === "side") tvClose();
        else if (k === "Enter" || k === " ") {
          const el = document.activeElement;
          if (el && el !== document.body) el.click();
          if (panel === "side") tvClose();
        }
        return handled();
      }
      if (k === "ContextMenu" || k === "Menu" || k === "Settings" || k === "m" || k === "M") return handled(), tvOpen("menu");
      if (!cur) { /* the welcome screen: pick a song, or change a setting */
        if (k.startsWith("Arrow")) moveGrid(k);
        else if (k === "Enter" && document.activeElement?.classList.contains("tv-chip")) document.activeElement.click();
        else if (k === "Enter" && document.activeElement?.classList.contains("pick")) document.activeElement.click();
        else if (k === "Enter") moveGrid("ArrowRight");
        return handled();
      }
      if (k === "Enter" || k === " ") togglePlay();
      else if (k === "ArrowDown") tvOpen("side");
      else if (k === "ArrowUp") tvOpen("menu");
      else if ((k === "ArrowLeft" || k === "ArrowRight") && player) player.seekTo(Math.max(0, videoTime() + (k === "ArrowLeft" ? -10 : 10)), true);
      else return;
      handled();
    },
    true
  );
}

/* the TV app's helper (inside YouTube's player) says when an ad is on: it gets it out of the way
 * (skips it, or plays it muted and fast) while this card covers it */
window.addEventListener("message", (e) => {
  if (!/^https:\/\/(www\.)?youtube(-nocookie)?\.com$/.test(e.origin) || !e.data || typeof e.data.musicboxAd !== "boolean") return;
  $("adCard").hidden = !e.data.musicboxAd;
});

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
  if (TV) {
    document.body.classList.toggle("idle-screen", !cur);
    tvHint();
    setTimeout(() => !cur && moveGrid("ArrowRight"), 300);
  }
}
window.addEventListener("pagehide", leaveSong);
start().catch((e) => {
  $("lockMsg").className = "lock-msg bad";
  $("lockMsg").textContent = "Couldn't load the songs: " + e.message;
});
