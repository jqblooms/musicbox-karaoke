/* musicbox karaoke - shared by the karaoke page and the songbook: helpers, the lock, and the
 * encrypted songs.
 *
 * The songs are encrypted (AES-256-GCM, key from the password with PBKDF2-SHA256): data/meta.json
 * says how, data/index.bin is the song list, data/c/N.bin hold the charts (a song's shard is its id
 * modulo the shard count), fetched when first needed, and data/config.bin the songbook's database
 * settings. A page defines window.onUnlocked() and calls start(). */
"use strict";

const $ = (id) => document.getElementById(id);
const b64 = {
  enc: (u8) => btoa(String.fromCharCode(...u8)),
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
const MUTED = new URLSearchParams(location.search).get("mute") === "1"; /* ?mute=1: silent (testing) */
const thumb = (yt) => `https://i.ytimg.com/vi/${yt}/mqdefault.jpg`;
const ytOf = (s) => s.v || s.a;
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem(key) || "null");
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ the encrypted songs */
let meta = null, key = null, songs = null, config = null;
/* child-friendly mode (on unless switched off, remembered): `songs` is then the list without the
 * songs marked explicit at build time (x: 1 their words, 2 their artist), so nothing explicit can
 * be found, recommended, queued or played */
let songsAll = null, songsKids = null;
let kids = store("mbxKids") !== false;
function setKids(on) {
  kids = !!on;
  store("mbxKids", kids);
  if (songsAll) songs = kids ? songsKids : songsAll;
  for (const id of ["kidsLock", "kidsSw"]) if ($(id)) $(id).checked = kids;
}
const shards = new Map();

async function rawKey(password) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: b64.dec(meta.salt), iterations: meta.iter }, base, 256);
  return new Uint8Array(bits);
}

async function openFile(path) {
  const r = await fetch(`data/${path}?b=${meta.built}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12));
  const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  return JSON.parse(text);
}

/* The key in a link (the songbook's QR code): base64url after "k=" in the part after "#", which
 * browsers never send to a server. */
const b64url = {
  enc: (u8) => b64.enc(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => b64.dec(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)),
};
let keyBytes = null; /* the unlocked key, for putting in the QR code */

async function unlock(raw) {
  key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const rows = await openFile("index.bin"); /* a wrong key fails here (the data will not authenticate) */
  keyBytes = raw;
  songsAll = MbxRecommend.prepare(rows.map(([id, artist, title, language, year, genre, v, a, x, p]) => ({ id, artist, title, language, year, genre, v, a, x: x || 0, p: p || 0 })));
  songsKids = MbxRecommend.prepare(songsAll.filter((s) => !s.x));
  setKids(kids);
  try {
    config = await openFile("config.bin"); /* the songbook's database settings (not in every build) */
  } catch {
    config = null;
  }
}

async function chartText(id) {
  const n = id % meta.shards;
  if (!shards.has(n)) shards.set(n, openFile(`c/${n}.bin`));
  return (await shards.get(n))[id] || null;
}

let metaReady = null; /* the page asks for data/meta.json at once; unlocking waits for it */
async function start() {
  metaReady = fetch("data/meta.json", { cache: "no-cache" }).then((r) => r.json());
  meta = await metaReady;
  if ($("kidsLock")) {
    $("kidsLock").checked = kids;
    $("kidsLock").addEventListener("change", (e) => setKids(e.target.checked));
  }
  /* a link with the key in it (scanned QR code): unlock at once, remember it, and take the key
   * out of the address bar so it isn't bookmarked or shared by accident */
  const fromLink = (location.hash.match(/[#&]k=([A-Za-z0-9_-]{40,})/) || [])[1];
  if (fromLink) {
    history.replaceState(null, "", location.href.replace(/([#&])k=[A-Za-z0-9_-]+&?/, "$1").replace(/[#&]$/, ""));
    $("lockForm").hidden = true;
    $("lockMsg").textContent = "Opening…";
    try {
      const raw = b64url.dec(fromLink);
      await unlock(raw);
      store("mbxKey", { salt: meta.salt, key: b64.enc(raw) });
      return window.onUnlocked();
    } catch {
      /* an old code (the songs were rebuilt since): fall back to what's remembered, or the password */
      $("lockForm").hidden = false;
      $("lockMsg").textContent = "That code is out of date - scan the screen again, or use the password.";
    }
  }
  /* the TV app passes the password after the # (never sent anywhere): it works with every build,
   * unlike a key, which changes when the songs are rebuilt */
  const pwLink = (location.hash.match(/[#&]pw=([^&]+)/) || [])[1];
  if (pwLink) {
    history.replaceState(null, "", location.href.replace(/([#&])pw=[^&]+&?/, "$1").replace(/[#&]$/, ""));
    $("lockForm").hidden = true;
    $("lockMsg").textContent = "Opening…";
    try {
      const raw = await rawKey(decodeURIComponent(pwLink));
      await unlock(raw);
      store("mbxKey", { salt: meta.salt, key: b64.enc(raw) });
      return window.onUnlocked();
    } catch {
      $("lockForm").hidden = false;
      $("lockMsg").textContent = "";
    }
  }
  const saved = store("mbxKey");
  if (saved && saved.salt === meta.salt) {
    try {
      await unlock(b64.dec(saved.key));
      return window.onUnlocked();
    } catch {
      store("mbxKey", null);
    }
  }
  $("pw").focus();
}

$("lockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("lockMsg");
  msg.className = "lock-msg";
  msg.textContent = "Unlocking…";
  try {
    meta = meta || (await metaReady);
    const raw = await rawKey($("pw").value);
    await unlock(raw);
    if ($("remember").checked) store("mbxKey", { salt: meta.salt, key: b64.enc(raw) });
    window.onUnlocked();
  } catch {
    msg.className = "lock-msg bad";
    msg.textContent = "That's not the password.";
    const card = document.querySelector(".lock-card");
    card.classList.remove("shake");
    void card.offsetWidth;
    card.classList.add("shake");
    $("pw").select();
  }
});


/* ------------------------------------------------------------------ the songbook's live database
 * Firebase Realtime Database, signed in anonymously; everything lives under the group's key (only
 * people with the password have it): groups/<key>/sessions/<session>/{host, seen, now, queue}. */
const FIREBASE = "https://www.gstatic.com/firebasejs/10.12.2/";
let live = null;
function liveConnect() {
  if (live) return live;
  live = (async () => {
    if (!config || !config.firebase) throw new Error("this build has no songbook settings");
    const [appMod, authMod, db] = await Promise.all([
      import(FIREBASE + "firebase-app.js"),
      import(FIREBASE + "firebase-auth.js"),
      import(FIREBASE + "firebase-database.js"),
    ]);
    const app = appMod.initializeApp(config.firebase);
    const auth = authMod.getAuth(app);
    const cred = await authMod.signInAnonymously(auth);
    return { db, database: db.getDatabase(app), uid: cred.user.uid, base: `groups/${config.group}/sessions` };
  })();
  live.catch(() => (live = null));
  return live;
}

function newSessionId() {
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => abc[b % abc.length]).join("");
}

/* Fair turns: picks alternate between people (everyone's 1st pick, then everyone's 2nd, ...), in the
 * order they came within a round - so one person filling the queue can't lock everyone else out.
 * items: [{by (who), at (when)}]; the screen and the phones use the same order. */
function fairOrder(items) {
  const sorted = [...items].sort((a, b) => (a.at || 0) - (b.at || 0));
  const count = new Map();
  const round = new Map(sorted.map((it) => {
    const n = count.get(it.by || "") || 0;
    count.set(it.by || "", n + 1);
    return [it, n];
  }));
  return sorted.sort((a, b) => round.get(a) - round.get(b) || (a.at || 0) - (b.at || 0));
}
const ordinal = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");
