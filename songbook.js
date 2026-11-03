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
const myName = () => $("name").value.trim().slice(0, 40);
$("name").value = store("mbxName") || "";
$("name").addEventListener("change", () => store("mbxName", myName()));

async function pick(s) {
  if (!fb) return toast("Not connected yet");
  if (!myName()) {
    toast("Put your name in first");
    $("name").focus();
    return;
  }
  store("mbxName", myName());
  const { db, database } = fb;
  try {
    await db.push(db.ref(database, path + "/queue"), { id: s.id, title: s.title.slice(0, 200), artist: s.artist.slice(0, 200), name: myName(), by: fb.uid, at: db.serverTimestamp() });
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
    paintNow();
  });
  db.onValue(db.ref(database, path + "/seen"), (snap) => {
    seen = snap.val() || 0;
    paintHost();
  });
  db.onValue(db.ref(database, ".info/serverTimeOffset"), (snap) => (skew = snap.val() || 0));
  setInterval(paintHost, 10000);
  paintQueue();
  paintNow();
  if (!myName()) $("name").focus();
};

start().catch((e) => {
  $("lockMsg").className = "lock-msg bad";
  $("lockMsg").textContent = "Couldn't load the songs: " + e.message;
});
