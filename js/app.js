/* chaklicard — витрина
   Слои: (1) физика стикеров (Matter.js), (2) винил, (3) аудио.

   Защита (двойная, всё на клиенте, без сервера):
     • Гейт входа — токен с карты хэшируется (SHA-256) и сверяется с PASS_HASH.
       В исходниках лежит только хэш: по нему сам токен не восстановить.
     • Контент — трек зашифрован AES-GCM ключом, выведенным из того же токена
       (PBKDF2). Файл assets/track.enc публичный, но без токена он бесполезен.
   Токен нигде в репозитории не хранится — приходит из URL карты (/11/?t=TOKEN). */

const $ = (s) => document.querySelector(s);
const BASE = window.__BASE__ || "";   // карта в /11/ => ассеты на уровень выше

/* ===================================================================
   СЛОЙ БЕЗОПАСНОСТИ
   Формат track.enc:  salt(16) + iv(12) + ciphertext(+tag)
   =================================================================== */
const PBKDF2_ITER = 150000;

// SHA-256(токен) в hex — сверяем с ним. Это НЕ сам токен, обратно не разворачивается.
const PASS_HASH = "17da7c9aea717e13ea79f0663a505279da201955f8f4547305d3c89e90a84348";

// токен с NFC-карты: /11/?t=TOKEN  (принимаем и #t= как запасной вариант)
function getToken() {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ""));
  const t = (q.get("t") || h.get("t") || "").trim();
  // подчистить URL, чтобы токен не мелькал в адресной строке / Referer
  if (t) history.replaceState(null, "", location.pathname);
  return t;
}

async function sha256hex(str) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deriveKey(token, salt) {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(token), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

// вернёт: { ok:true, track:<blobURL> } | { ok:false, reason } | { missing:true }
// onProgress(получено, всего) дёргается по мере скачивания track.enc
async function unlock(token, onProgress) {
  if (!token) return { ok: false, reason: "no-code" };

  // 1) быстрый гейт по хэшу — без скачивания трека
  const h = await sha256hex(token);
  if (h !== PASS_HASH) return { ok: false, reason: "bad-code" };

  // 2) достаём и расшифровываем трек (стримим, чтобы показывать прогресс)
  let buf;
  try {
    const res = await fetch(BASE + "assets/track.enc");
    if (!res.ok) return { missing: true };            // ещё не зашифрован (dev)
    const total = +res.headers.get("Content-Length") || 0;
    if (res.body && total) {
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (onProgress) onProgress(got, total);
      }
      buf = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
    } else {
      buf = new Uint8Array(await res.arrayBuffer());
    }
  } catch { return { missing: true }; }

  try {
    const salt = buf.slice(0, 16), iv = buf.slice(16, 28), ct = buf.slice(28);
    const key = await deriveKey(token, salt);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    const url = URL.createObjectURL(new Blob([plain], { type: "audio/mpeg" }));
    return { ok: true, track: url };
  } catch {
    return { ok: false, reason: "bad-code" };
  }
}

const state = {
  playing: false,
  muted: false,
  audio: null,      // { play, pause, seek(t), duration(), current(), setMute } — единый интерфейс
  manifest: { stickers: [], photos: [] },
  cfg: null,
};

/* ------------------------------------------------------------------ */
/*  1. АССЕТЫ                                                          */
/* ------------------------------------------------------------------ */
async function loadManifest() {
  try {
    const r = await fetch(BASE + "assets/manifest.json", { cache: "no-store" });
    state.manifest = await r.json();
  } catch (e) {
    console.warn("[chaklicard] манифест не найден", e);
  }
  const pool = state.manifest.stickers.length ? state.manifest.stickers : state.manifest.photos;
  // лейбл винила — случайный арт
  if (pool.length) $("#labelArt").src = BASE + "assets/stickers/" + pick(pool);
}

const pick = (a) => a[(Math.random() * a.length) | 0];
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((p) => p[1]);

/* ------------------------------------------------------------------ */
/*  2. ФИЗИКА СТИКЕРОВ                                                 */
/* ------------------------------------------------------------------ */
let physics = null;

// профиль устройства: расстояние между стикерами, размеры и количество — под экран
function deviceProfile() {
  const w = window.innerWidth, h = window.innerHeight;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const minSide = Math.min(w, h);
  const phone  = w <= 640 || (coarse && minSide <= 820);
  const tablet = !phone && (w <= 1024 || coarse);
  if (phone)  return { name: "phone",   spacing: 108, sMin: 50, sMax: 90,  max: 16 };
  if (tablet) return { name: "tablet",  spacing: 128, sMin: 56, sMax: 120, max: 32 };
  return              { name: "desktop", spacing: 152, sMin: 62, sMax: 158, max: 999 };
}

function teardownPhysics() {
  if (!physics) return;
  Matter.Runner.stop(physics.runner);
  clearInterval(physics.wind);
  // снять слушатели мыши/касаний, чтобы не копились при пересборке
  const m = physics.mouse, el = m.element;
  el.removeEventListener("mousemove", m.mousemove);
  el.removeEventListener("mousedown", m.mousedown);
  el.removeEventListener("mouseup", m.mouseup);
  el.removeEventListener("touchmove", m.mousemove);
  el.removeEventListener("touchstart", m.mousedown);
  el.removeEventListener("touchend", m.mouseup);
  physics.stage.querySelectorAll(".sticker").forEach((n) => n.remove());
  physics = null;
}

function initStickers() {
  if (!window.Matter) return;
  layoutStickers();

  let deb;
  window.addEventListener("resize", () => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      const p = deviceProfile();
      if (!physics || physics.profileName !== p.name) layoutStickers();  // сменилось устройство/ориентация — пересобрать
      else physics.buildWalls();                                          // тот же класс — просто подвинуть стены
    }, 280);
  });
  window.addEventListener("orientationchange", () => setTimeout(layoutStickers, 320));
}

function layoutStickers() {
  const { Engine, Runner, Bodies, Body, Composite, Mouse, MouseConstraint, Events } = Matter;
  const stage = $("#stage");
  const W = () => window.innerWidth;
  const H = () => window.innerHeight;
  const prof = deviceProfile();

  teardownPhysics();

  const engine = Engine.create();
  engine.gravity.x = engine.gravity.y = 0;   // невесомость — стикеры дрейфуют
  const world = engine.world;

  // стены
  const wallOpts = { isStatic: true, restitution: 1 };
  let walls = [];
  const buildWalls = () => {
    Composite.remove(world, walls);
    const t = 200;
    walls = [
      Bodies.rectangle(W() / 2, -t / 2, W() + t, t, wallOpts),
      Bodies.rectangle(W() / 2, H() + t / 2, W() + t, t, wallOpts),
      Bodies.rectangle(-t / 2, H() / 2, t, H() + t, wallOpts),
      Bodies.rectangle(W() + t / 2, H() / 2, t, H() + t, wallOpts),
    ];
    Composite.add(world, walls);
  };
  buildWalls();

  // раскладка по сетке с джиттером — расстояния между стикерами подстроены под устройство
  const cols = Math.max(2, Math.floor(W() / prof.spacing));
  const rows = Math.max(2, Math.floor(H() / prof.spacing));
  const cw = W() / cols, ch = H() / rows;
  const cells = shuffle(Array.from({ length: cols * rows }, (_, i) => i));

  const all = shuffle([...state.manifest.stickers, ...state.manifest.photos]);
  const count = Math.min(all.length, prof.max, cells.length);
  const pool = all.slice(0, count);
  const items = [];

  // добавляем стикер после загрузки — чтобы знать реальные пропорции (без искажения)
  function addSticker(file, cellIdx) {
    const col = cellIdx % cols, row = (cellIdx / cols) | 0;
    const cx = (col + 0.5) * cw + (Math.random() - 0.5) * cw * 0.45;   // джиттер в пределах ячейки
    const cy = (row + 0.5) * ch + (Math.random() - 0.5) * ch * 0.45;

    const probe = new Image();
    probe.onload = () => {
      if (!physics || physics.engine !== engine) return;   // раскладку уже пересобрали
      const ratio = probe.naturalWidth / probe.naturalHeight || 1;
      const longSide = prof.sMin + Math.random() * (prof.sMax - prof.sMin);
      let w, h;
      if (ratio >= 1) { w = longSide; h = longSide / ratio; }
      else            { h = longSide; w = longSide * ratio; }

      const el = document.createElement("div");
      el.className = "sticker";
      el.style.width = w + "px";
      el.style.height = h + "px";
      el.style.setProperty("--wob", (3.5 + Math.random() * 4).toFixed(2) + "s");
      el.style.animationDelay = (Math.random() * 0.5).toFixed(2) + "s";
      const img = document.createElement("img");
      img.src = BASE + "assets/stickers/" + file;
      img.alt = "";
      el.appendChild(img);
      stage.appendChild(el);

      const body = Bodies.rectangle(cx, cy, w * 0.8, h * 0.8, {
        restitution: 0.9, frictionAir: 0.012, friction: 0,
        angle: (Math.random() - 0.5) * 0.9,
        chamfer: { radius: Math.min(w, h) * 0.18 },
      });
      Body.setVelocity(body, { x: (Math.random() - 0.5) * 2.4, y: (Math.random() - 0.5) * 2.4 });
      Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.06);   // сами крутятся
      Composite.add(world, body);
      items.push({ el, body, w, h });
    };
    probe.src = BASE + "assets/stickers/" + file;
  }
  pool.forEach((f, i) => addSticker(f, cells[i]));

  // мышь / касание — хватать и кидать.
  // ВАЖНО: слушаем #stage, а не document.body — обработчики Matter делают
  // preventDefault на touchstart и убивали tap-клики по кнопкам на телефоне.
  const mouse = Mouse.create(stage);
  const mc = MouseConstraint.create(engine, {
    mouse, constraint: { stiffness: 0.18, render: { visible: false } },
  });
  Composite.add(world, mc);
  mouse.element.removeEventListener("wheel", mouse.mousewheel);

  // рендер DOM по позициям тел
  Events.on(engine, "afterUpdate", () => {
    for (const it of items) {
      const { x, y } = it.body.position;
      it.el.style.transform =
        `translate(${x - it.w / 2}px, ${y - it.h / 2}px) rotate(${it.body.angle}rad)`;
    }
  });

  // мягкий «ветер», чтобы не застывали
  const wind = setInterval(() => {
    for (const it of items) {
      const sp = Math.hypot(it.body.velocity.x, it.body.velocity.y);
      if (sp < 1.4) {
        Body.applyForce(it.body, it.body.position, {
          x: (Math.random() - 0.5) * it.body.mass * 0.004,
          y: (Math.random() - 0.5) * it.body.mass * 0.004,
        });
      }
    }
  }, 1600);

  const runner = Runner.create();
  Runner.run(runner, engine);
  physics = { runner, engine, stage, mouse, buildWalls, wind, profileName: prof.name };
}

/* ------------------------------------------------------------------ */
/*  3. АУДИО                                                          */
/* ------------------------------------------------------------------ */
// реальный трек (src — blob-URL расшифрованного mp3)
function makeHowl(src) {
  // format обязателен: src — blob-URL без расширения, иначе Howler молча не грузит
  const howl = new Howl({ src: [src], format: ["mp3"], html5: true, loop: true, volume: 0.9 });
  return {
    play: () => howl.play(),
    pause: () => howl.pause(),
    seek: (t) => howl.seek(t),
    current: () => howl.seek() || 0,
    duration: () => howl.duration() || 0,
    setMute: (m) => howl.mute(m),
  };
}

// синтезированная lo-fi петля (заглушка, пока нет трека)
function makeSynth() {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = 0.0;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass"; filter.frequency.value = 1600; filter.Q.value = 0.4;
  filter.connect(master); master.connect(ctx.destination);

  // винтажный «шум пластинки»
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.06;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf; noise.loop = true;
  const ng = ctx.createGain(); ng.gain.value = 0.5;
  noise.connect(ng); ng.connect(master); noise.start();

  // аккордовая прогрессия (мягкое электропиано)
  const A = 220;
  const chords = [
    [A * 0.75, A * 0.9, A * 1.125],   // Fmaj-ish
    [A * 0.84, A, A * 1.26],          // Am
    [A * 0.67, A * 0.84, A],          // Dm
    [A * 0.75, A * 0.9, A * 1.5],     // G
  ];
  let step = 0, timer = null;
  const beat = 1.9;

  function voice(freq, t, dur) {
    const o = ctx.createOscillator();
    o.type = "triangle"; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(filter);
    o.start(t); o.stop(t + dur + 0.1);
  }
  function schedule() {
    const t = ctx.currentTime + 0.03;
    chords[step % chords.length].forEach((f, i) => voice(f, t + i * 0.015, beat * 1.3));
    voice(chords[step % chords.length][0] / 2, t, beat);       // бас
    step++;
  }

  const fake = { t0: 0, paused: true, acc: 0 };
  return {
    play: () => {
      if (ctx.state === "suspended") ctx.resume();
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.linearRampToValueAtTime(state.muted ? 0 : 0.5, ctx.currentTime + 0.6);
      if (!timer) { schedule(); timer = setInterval(schedule, beat * 1000); }
      fake.t0 = ctx.currentTime - fake.acc; fake.paused = false;
    },
    pause: () => {
      master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
      clearInterval(timer); timer = null;
      fake.acc = ctx.currentTime - fake.t0; fake.paused = true;
    },
    seek: () => {},
    current: () => (fake.paused ? fake.acc : ctx.currentTime - fake.t0),
    duration: () => 0,   // 0 => бесконечная петля
    setMute: (m) => master.gain.linearRampToValueAtTime(m ? 0 : 0.5, ctx.currentTime + 0.2),
  };
}

/* ------------------------------------------------------------------ */
/*  4. УПРАВЛЕНИЕ / UI                                                */
/* ------------------------------------------------------------------ */
const fmt = (s) => {
  if (!s || !isFinite(s)) return "∞";
  s = Math.floor(s);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

function setPlaying(on) {
  state.playing = on;
  document.body.classList.toggle("playing", on);
  $("#btnPlay").textContent = on ? "❙❙" : "►";
  on ? state.audio.play() : state.audio.pause();
}

function wireControls() {
  $("#btnPlay").onclick = () => setPlaying(!state.playing);
  $("#btnPrev").onclick = () => { state.audio.seek(0); };
  $("#btnMute").onclick = () => {
    state.muted = !state.muted;
    state.audio.setMute(state.muted);
    $("#btnMute").style.opacity = state.muted ? 0.4 : 1;
  };

  const bar = $("#bar");
  bar.onclick = (e) => {
    const d = state.audio.duration();
    if (!d) return;
    const r = bar.getBoundingClientRect();
    state.audio.seek(((e.clientX - r.left) / r.width) * d);
  };

  // прогресс
  setInterval(() => {
    const cur = state.audio.current();
    const dur = state.audio.duration();
    $("#tCur").textContent = fmt(cur);
    $("#tDur").textContent = dur ? fmt(dur) : "∞";
    const p = dur ? Math.min(1, cur / dur) : (cur % 30) / 30; // без длительности — декоративная бегущая полоска
    $("#fill").style.width = p * 100 + "%";
    $("#knob").style.left = p * 100 + "%";
  }, 250);
}

/* ------------------------------------------------------------------ */
/*  5. СТАРТ                                                          */
/* ------------------------------------------------------------------ */
function wireTheme() {
  const btn = $("#themeToggle");
  const apply = (t) => {
    document.body.setAttribute("data-theme", t);
    btn.textContent = t === "dark" ? "☾" : "◑";
  };
  let cur = localStorage.getItem("chaklicard-theme") || "warm";
  apply(cur);
  btn.onclick = () => {
    cur = cur === "warm" ? "dark" : "warm";
    localStorage.setItem("chaklicard-theme", cur);
    apply(cur);
  };
}

function lockCover(msg) {
  $("#cover").classList.add("locked");
  document.querySelector(".sleeve .kicker").textContent = "chaklicard";
  document.querySelector(".sleeve h2").textContent = "invalid card";
  $("#enter").style.display = "none";
  document.querySelector(".sleeve .hint").textContent = msg || "код не распознан";
}

async function boot() {
  wireTheme();
  await loadManifest();
  initStickers();

  // токен из URL карты. Скачивание/расшифровка идут в фоне,
  // а клик вешаем сразу — иначе кнопка мертва, пока качается track.enc.
  const token = getToken();
  const dl = { got: 0, total: 0 };
  const unlockP = unlock(token, (got, total) => { dl.got = got; dl.total = total; });

  const enter = $("#enter");
  enter.onclick = async () => {
    enter.disabled = true;
    // пока трек качается — показываем реальный процент, а не немую кнопку
    const tick = setInterval(() => {
      enter.textContent = dl.total
        ? `⏳ ${Math.round((dl.got / dl.total) * 100)}%`
        : "⏳ открываю…";
    }, 150);

    let res;
    try {
      res = await unlockP;
    } catch (e) {
      clearInterval(tick);
      enter.disabled = false;
      enter.textContent = "⚠ " + (e && e.message ? e.message : "ошибка — нажми ещё раз");
      console.error("[chaklicard] unlock:", e);
      return;
    }
    clearInterval(tick);

    if (!res.ok && !res.missing) {
      lockCover(res.reason === "no-code" ? "поднеси карту — нужен код" : "код неверный");
      return;
    }
    if (res.ok) {
      $("#trackTitle").textContent = "nobody else";
      $("#trackBy").textContent = "LANY";
    }
    // res.missing => track.enc нет (локальная разработка) — синт-заглушка
    state.audio = res.ok ? makeHowl(res.track) : makeSynth();
    wireControls();
    $("#cover").classList.add("gone");
    $("#player").classList.remove("hidden");
    setPlaying(true);       // играет сразу после входа
  };

  // токен неверный/отсутствует — лочим обложку, не дожидаясь клика
  unlockP.then((res) => {
    if (!res.ok && !res.missing) {
      lockCover(res.reason === "no-code" ? "поднеси карту — нужен код" : "код неверный");
    }
  }).catch(() => {});   // ошибку покажет обработчик клика
}

document.addEventListener("DOMContentLoaded", boot);
