/* musicbox karaoke - the phone as a microphone. The voice never leaves the phone: it plays back
 * through the phone itself ("Hear yourself", on by default), cleaned up for a party:
 *
 *   mic -> high-pass (rumble, handling noise) -> noise gate -> compressor -> volume -> speaker
 *                \-> analyser (level meter now; pitch for scoring later)
 *
 * Noisy room mode (on by default) asks the browser for its echo cancelling and noise suppression
 * (they also stop the phone hearing its own speaker), and sets the gate to open only for a voice
 * close to the phone, well above the room's level - which it learns as it goes. A howl (feedback
 * between speaker and mic) is spotted and the volume pulled down at once.
 * Settings are remembered; starting needs a tap (browsers only allow sound after one). */
const MbxMic = (() => {
  "use strict";
  const save = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  };
  const load = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      return v === null ? d : v;
    } catch {
      return d;
    }
  };

  const st = {
    on: false,
    hear: load("mbxHear", true),
    noisy: load("mbxNoisy", true),
    vol: load("mbxMicVol", 0.8),
    level: 0, /* 0..1, for the meter */
    open: false, /* the gate is letting the voice through */
    feedback: false,
    latency: 0, /* seconds from the mic to the speaker, as far as the browser knows */
    error: "",
  };
  let ctx = null, stream = null, src = null, hp, gate, comp, out, analyser, timer = 0, wake = null;
  let floor = 0.01, lastOpen = 0, howl = 0, duckUntil = 0;
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f(st));

  function build() {
    ctx = new AudioContext({ latencyHint: "interactive" });
    hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 110;
    gate = ctx.createGain();
    gate.gain.value = 0;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -26;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    out = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    hp.connect(gate).connect(comp).connect(out).connect(ctx.destination);
    hp.connect(analyser);
  }

  async function openStream() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    src?.disconnect();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: st.noisy, noiseSuppression: st.noisy, autoGainControl: false, channelCount: 1 },
    });
    src = ctx.createMediaStreamSource(stream);
    src.connect(hp);
  }

  function applyOut() {
    if (!out) return;
    const duck = performance.now() < duckUntil ? 0.25 : 1;
    out.gain.setTargetAtTime(st.hear ? st.vol * duck : 0, ctx.currentTime, 0.03);
  }

  const buf = new Float32Array(2048), spec = new Float32Array(1024);
  function tick() {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    /* the room's level: follows quiet moments quickly, loud ones only slowly */
    floor = rms < floor ? floor * 0.9 + rms * 0.1 : floor * 1.0015;
    floor = Math.max(0.0015, Math.min(floor, 0.2));
    const threshold = st.noisy ? Math.max(floor * 3.2, 0.012) : Math.max(floor * 1.8, 0.004);
    const now = performance.now();
    if (rms > threshold) lastOpen = now;
    const open = now - lastOpen < 220; /* hold briefly so word endings aren't chopped */
    gate.gain.setTargetAtTime(open ? 1 : st.noisy ? 0 : 0.12, ctx.currentTime, open ? 0.004 : 0.08);
    /* feedback: one loud, narrow tone growing for a third of a second */
    if (st.hear) {
      analyser.getFloatFrequencyData(spec);
      let peak = -200, mean = 0;
      for (let i = 4; i < spec.length; i++) {
        mean += spec[i];
        if (spec[i] > peak) peak = spec[i];
      }
      mean /= spec.length - 4;
      howl = rms > 0.15 && peak - mean > 32 ? howl + 1 : Math.max(0, howl - 1);
      if (howl > 15) {
        duckUntil = now + 4000;
        howl = 0;
      }
    }
    const fb = now < duckUntil;
    if (fb !== st.feedback) {
      st.feedback = fb;
      applyOut();
    }
    st.level = Math.min(1, rms * 6);
    st.open = open;
    emit();
  }

  async function start() {
    st.error = "";
    try {
      if (!ctx) build();
      await ctx.resume();
      await openStream();
    } catch (e) {
      st.error = e && e.name === "NotAllowedError" ? "The mic is blocked: allow it for this page in the browser's settings." : "Couldn't start the mic: " + (e.message || e);
      emit();
      return false;
    }
    st.latency = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    clearInterval(timer);
    timer = setInterval(tick, 20);
    applyOut();
    try {
      wake = await navigator.wakeLock?.request("screen"); /* the screen stays on while singing */
    } catch {}
    st.on = true;
    emit();
    return true;
  }

  function stop() {
    clearInterval(timer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (gate) gate.gain.value = 0;
    wake?.release?.();
    wake = null;
    st.on = false;
    st.level = 0;
    emit();
  }

  return {
    st,
    start,
    stop,
    onChange: (f) => listeners.add(f),
    setHear(on) {
      st.hear = on;
      save("mbxHear", on);
      applyOut();
      emit();
    },
    setVol(v) {
      st.vol = v;
      save("mbxMicVol", v);
      applyOut();
    },
    async setNoisy(on) {
      st.noisy = on;
      save("mbxNoisy", on);
      if (st.on) await openStream(); /* the browser's echo and noise cleaning are set when the mic opens */
      emit();
    },
    analyser: () => analyser,
    context: () => ctx,
  };
})();
