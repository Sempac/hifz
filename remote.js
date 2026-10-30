'use strict';

// ---------- Reconnaissance par le serveur Hifz ----------
// Au lieu de la reconnaissance du téléphone (Google / Apple), l'application enregistre elle-même
// le micro et l'envoie au serveur Hifz (WebSocket, PCM 16 bits mono 16 kHz, morceaux de 200 ms).
// Le serveur renvoie le texte avec les voyelles. ServerRecognizer imite l'interface de la
// reconnaissance du navigateur (start, abort, onresult, onend…) : le reste de l'application
// fonctionne sans changement.

// Conversion du micro en 16 kHz mono, morceaux de 200 ms (traitement audio en arrière-plan)
const PCM_WORKLET = `
class Pcm16k extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.t = 0; this.acc = 0; this.cnt = 0; this.buf = new Int16Array(3200); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.cnt++; this.t += 1;
      if (this.t >= this.ratio) {
        this.t -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.cnt));
        this.acc = 0; this.cnt = 0;
        this.buf[this.n++] = v * 32767;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pcm16k', Pcm16k);`;

// Le micro reste ouvert pendant toute la récitation (même pendant un rappel) : une seule
// autorisation, et pas de délai de réouverture.
const mic = { stream: null, ctx: null, sink: null };

async function ensureMic() {
  if (!mic.stream) {
    // son brut : les traitements du navigateur (réduction de bruit, volume automatique) altèrent
    // la voix et faussent la reconnaissance des voyelles. Le micro n'envoie rien pendant un rappel,
    // donc pas besoin d'annulation d'écho.
    mic.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    mic.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const url = URL.createObjectURL(new Blob([PCM_WORKLET], { type: 'text/javascript' }));
    await mic.ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(mic.ctx, 'pcm16k');
    node.port.onmessage = (e) => { if (mic.sink) { mic.sink(e.data); coachFrames(e.data); } };
    mic.ctx.createMediaStreamSource(mic.stream).connect(node);
  }
  if (mic.ctx.state === 'suspended') await mic.ctx.resume();
}

function releaseMic() {
  mic.sink = null;
  if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop());
  if (mic.ctx) mic.ctx.close().catch(() => {});
  mic.stream = null;
  mic.ctx = null;
  closeSocket();
  coachReset();
}

// ---------- Conseils de récitation, comme un cheikh : volume et vitesse ----------
// Le son est découpé en trames de 50 ms (niveau en dB). Une trame est de la voix si elle est à
// moins de 20 dB du niveau fort récent (p95) : c'est la mesure qui a servi à fixer la zone de
// vitesse sur des récitateurs (mots par seconde de voix, sourates 3 et 56) : al-Husary ≈ 0,5-0,7,
// al-Minshawi ≈ 0,7-0,8, as-Sudais et ash-Shuraym ≈ 1,0-1,3. Les mots arrivent du serveur par
// paquets et en retard : la mesure est faite sur 60 s, et « plus lentement » n'est dit qu'au-delà
// de 1,6 (nettement plus vite que le plus rapide). Pas de « plus vite » : une vitesse basse vient
// surtout de mots non compris, et réciter lentement ne gêne pas l'écoute. Un conseil ne
// s'affiche que si le défaut dure, au plus une fois toutes les 25 s, sans interrompre la récitation.
// (réglages vérifiés en rejouant les diagnostics du 29/10/2026)
const COACH = { fast: 1.6, window: 60, quiet: -48, every: 25000 };
const coach = { frames: [], words: [], said: 0, checked: 0, timer: 0 };

function coachReset() {
  coach.frames = []; coach.words = []; coach.said = 0; coach.checked = 0;
  $('#vu').hidden = true;
}

const pct = (arr, q) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

function coachFrames(buf) {
  const now = Date.now();
  for (let o = 0; o + 800 <= buf.length; o += 800) {
    let sum = 0, clip = 0;
    for (let k = o; k < o + 800; k++) { const v = buf[k]; sum += v * v; if (v >= 32000 || v <= -32000) clip++; }
    coach.frames.push({ t: now, db: 10 * Math.log10(sum / 800 / 32768 ** 2 + 1e-12), clip });
  }
  while (coach.frames.length && coach.frames[0].t < now - COACH.window * 1000) coach.frames.shift();
  // jauge : niveau des 200 dernières ms, de -60 dB (vide) à 0 dB (plein)
  const last = Math.max(...coach.frames.slice(-4).map((f) => f.db));
  const vu = $('#vu');
  vu.hidden = false;
  vu.firstElementChild.style.width = Math.max(0, Math.min(100, (last + 60) / 60 * 100)) + '%';
  vu.className = 'vu' + (coach.frames.slice(-4).some((f) => f.clip) ? ' loud' : last < COACH.quiet ? ' quiet' : '');
  if (now - coach.checked >= 1000) { coach.checked = now; coachCheck(now); }
}

// mots compris par le serveur (morceaux terminés), pour la vitesse
function coachWords(text) {
  const n = text.split(/\s+/).filter((t) => t.replace(/[^ء-يٱ]/g, '').length >= 2).length;
  if (n) coach.words.push({ t: Date.now(), n });
  while (coach.words.length && coach.words[0].t < Date.now() - COACH.window * 1000) coach.words.shift();
}

function coachCheck(now) {
  // volume sur les 15 dernières secondes ; « trop bas » seulement si une voix faible est là en
  // continu (au moins 30 % du temps au-dessus du bruit de fond), pas pendant une pause
  const recent = coach.frames.filter((f) => f.t >= now - 15000);
  if (recent.length < 280) return;
  const db = recent.map((f) => f.db), top = pct(db, 0.95), floor = pct(db, 0.1);
  let advice = '';
  if (recent.filter((f) => f.t >= now - 4000 && f.clip > 8).length >= 4) advice = '🔊 Un peu moins fort, ou éloignez le téléphone';
  else if (top < COACH.quiet && db.filter((d) => d > floor + 10).length >= 0.3 * db.length) advice = '🔉 Je vous entends mal : récitez un peu plus fort, ou rapprochez le téléphone';
  else {
    const all = coach.frames.map((f) => f.db), loud = pct(all, 0.95);
    const voice = all.filter((d) => d > loud - 20).length * 0.05;
    const words = coach.words.reduce((s, w) => s + w.n, 0);
    if (voice >= 12 && words >= 10) {
      const rate = words / voice;
      if (rate > COACH.fast) advice = `🐢 Un peu plus lentement, pour que je saisisse chaque mot (${rate.toFixed(2)} mot/s)`;
    }
  }
  if (!advice || now - coach.said < COACH.every) return;
  coach.said = now;
  micLog('conseil : ' + advice);
  const el = $('#coach');
  el.textContent = advice;
  el.hidden = false;
  clearTimeout(coach.timer);
  coach.timer = setTimeout(() => { el.hidden = true; }, 6000);
}

// Une seule connexion au serveur, ouverte toute la récitation : après un rappel, on ne se
// reconnecte pas (trop lent à travers internet), on demande au serveur de repartir de zéro.
// Chaque reprise a un numéro de session ; les réponses des sessions précédentes sont ignorées.
const conn = { ws: null, url: '', opening: null, sid: 0, listener: null };

function getSocket(url) {
  if (conn.ws && conn.ws.readyState === 1 && conn.url === url) return Promise.resolve(conn.ws);
  if (conn.opening && conn.url === url) return conn.opening;
  closeSocket();
  conn.url = url;
  conn.opening = new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { try { ws.close(); } catch { /* fermé */ } reject(new Error('délai')); }, 8000);
    ws.onopen = () => { clearTimeout(timer); conn.ws = ws; resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('réseau')); };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.sid === conn.sid && conn.listener) conn.listener.deliver(msg);
    };
    ws.onclose = () => {
      if (conn.ws === ws) conn.ws = null;
      mic.sink = null;
      if (conn.listener) conn.listener.end(); // l'application relance (et se reconnecte)
    };
  }).finally(() => { conn.opening = null; });
  return conn.opening;
}

function closeSocket() {
  const ws = conn.ws;
  conn.ws = null;
  conn.listener = null;
  if (ws) { try { ws.close(); } catch { /* fermé */ } }
}

class ServerRecognizer {
  constructor(url) {
    this.url = url;
    this.continuous = true;
    this.ended = false;
  }

  start() { this.open(); }

  async open() {
    try {
      await ensureMic();
    } catch {
      this.fail('not-allowed');
      return;
    }
    if (this.ended) return; // arrêté pendant l'ouverture du micro
    let ws;
    try {
      ws = await getSocket(rec.serverUrl);
    } catch {
      // serveur relancé entre-temps (nouvelle adresse) : on la cherche, puis un second essai
      const old = rec.serverUrl;
      await discoverServer(true);
      if (this.ended) return;
      try {
        if (rec.serverUrl === old) throw new Error('même adresse');
        ws = await getSocket(rec.serverUrl);
      } catch { this.fail('network'); return; }
    }
    if (this.ended) return;
    this.sid = ++conn.sid;
    ws.send(JSON.stringify({ type: 'reset', sid: this.sid })); // repartir de zéro
    conn.listener = this;
    mic.sink = (buf) => { if (ws.readyState === 1) ws.send(buf.buffer); };
    if (this.onstart) this.onstart();
    if (this.onaudiostart) this.onaudiostart();
  }

  deliver(msg) {
    // morceaux nouvellement terminés : comptés pour la vitesse
    const finals = (msg.segments || []).filter((s) => s.final);
    finals.slice(this.finals || 0).forEach((s) => coachWords(s.text));
    this.finals = Math.max(this.finals || 0, finals.length);
    const results = (msg.segments || []).map((s) => Object.assign([{ transcript: s.text, confidence: 1 }], { isFinal: s.final }));
    if (results.length && this.onresult) this.onresult({ results, resultIndex: 0 });
  }

  fail(code) {
    if (this.ended) return;
    if (this.onerror) this.onerror({ error: code });
    this.end();
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    if (this.onend) setTimeout(() => this.onend(), 0);
  }

  // pause (rappel, arrêt) : on cesse d'envoyer le son, la connexion reste ouverte
  abort() {
    if (conn.listener === this) { conn.listener = null; mic.sink = null; $('#vu').hidden = true; }
    this.end();
  }

  stop() { this.abort(); }
}

// ---------- Réglage : moteur de reconnaissance et adresse du serveur ----------

function applyEngineUi() {
  $('#engine').value = rec.engine;
  $('#server-url').value = rec.serverUrl;
  $('#server-row').hidden = rec.engine !== 'server';
}

// bouton micro et avertissement « reconnaissance non disponible » selon le réglage en cours
function refreshAvailability() {
  $('#btn-mic').disabled = !recognitionAvailable();
  $('#no-speech').hidden = recognitionAvailable();
}

$('#engine').addEventListener('change', () => {
  rec.engine = $('#engine').value;
  store.set('engine', rec.engine);
  applyEngineUi();
  if (rec.listening) { stopListening(); startListening(); }
  refreshAvailability();
});
$('#server-url').addEventListener('input', () => {
  rec.serverUrl = $('#server-url').value.trim();
  store.set('serverUrl', rec.serverUrl);
  refreshAvailability();
});
// Test par une connexion WebSocket, comme la récitation (une simple requête web serait bloquée
// par le navigateur, la page de santé du serveur n'autorisant pas les autres sites)
$('#server-test').addEventListener('click', () => {
  const out = $('#server-status');
  rec.serverUrl = $('#server-url').value.trim();
  store.set('serverUrl', rec.serverUrl);
  refreshAvailability();
  if (!/^wss?:\/\//.test(rec.serverUrl)) { out.textContent = '❌ L’adresse doit commencer par wss://'; return; }
  out.textContent = 'Test en cours…';
  let ws, done = false;
  const finish = (msg) => { if (done) return; done = true; out.textContent = msg; try { ws.close(); } catch { /* fermé */ } };
  const timer = setTimeout(() => finish('❌ Pas de réponse du serveur (adresse, réseau ou serveur éteint ?)'), 8000);
  try { ws = new WebSocket(rec.serverUrl); } catch { clearTimeout(timer); finish('❌ Adresse invalide'); return; }
  ws.onopen = () => { clearTimeout(timer); finish('✅ Serveur joignable'); };
  ws.onerror = () => { clearTimeout(timer); finish('❌ Serveur injoignable (adresse, réseau ou serveur éteint ?)'); };
});

// Adresse reçue par le lien (ou le QR code) affiché par le notebook Colab : …/hifz/#server=wss://…
// Elle est enregistrée et le mode serveur activé, sans rien recopier.
function serverFromLink() {
  const url = new URLSearchParams(location.hash.slice(1)).get('server');
  if (!url || !/^wss?:\/\//.test(url)) return;
  rec.serverUrl = url;
  rec.engine = 'server';
  store.set('serverUrl', url);
  store.set('engine', 'server');
  history.replaceState(null, '', location.pathname + location.search);
  applyEngineUi();
  refreshAvailability();
  alert('✅ Adresse du serveur Hifz enregistrée.\nReconnaissance : Serveur Hifz.');
}
window.addEventListener('hashchange', serverFromLink);

// Adresse annoncée par le serveur lui-même au démarrage, sur le canal ntfy.sh ci-dessous (le QR code
// n'est plus nécessaire). L'annonce est signée par la clé du notebook : seule une annonce vérifiée
// par cette clé publique est acceptée (n'importe qui peut écrire sur un canal ntfy).
const ANNOUNCE = {
  topic: 'hifz-cc9cc55225c80307',
  key: { kty: 'EC', crv: 'P-256', x: 'DbwNKFOB1uSI-gTjuwY84E8lb1uFCIiJX4HC20n5sW8', y: 'FR5Idd4rnNzJ7_M7W1fQUThIZ3HZPwuQ44SjdqNur7o', ext: true },
  maxAge: 12 * 3600, // une annonce plus vieille est ignorée (Kaggle arrête tout au bout de 12 h)
};
let discovered = 0; // heure de la dernière recherche (pas plus d'une toutes les 20 s)
rec.serverState = ''; // 'up' | 'down' | '' (inconnu) : dernière annonce vérifiée

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function verifyAnnounce(m) {
  if (!m || !['up', 'down'].includes(m.kind) || typeof m.sig !== 'string' || Math.abs(Date.now() / 1000 - m.t) > ANNOUNCE.maxAge) return false;
  if (m.kind === 'up' && !/^wss:\/\/[a-z0-9-]+\.trycloudflare\.com\/ws$/.test(m.url)) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', ANNOUNCE.key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64url(m.sig), new TextEncoder().encode(`${m.kind}|${m.url}|${m.t}`));
  } catch { return false; }
}

async function discoverServer(force) {
  if (!force && Date.now() - discovered < 20000) return;
  discovered = Date.now();
  let lines;
  try {
    const r = await fetch(`https://ntfy.sh/${ANNOUNCE.topic}/json?poll=1&since=12h`, { cache: 'no-store' });
    lines = (await r.text()).split('\n').filter(Boolean).reverse(); // la plus récente d'abord
  } catch { return; } // hors ligne : on garde l'adresse connue
  for (const line of lines) {
    let m;
    try { m = JSON.parse(JSON.parse(line).message); } catch { continue; }
    if (!(await verifyAnnounce(m))) continue;
    rec.serverState = m.kind;
    if (m.kind === 'up' && m.url !== rec.serverUrl) {
      rec.serverUrl = m.url;
      store.set('serverUrl', m.url);
      micLog('serveur : nouvelle adresse annoncée');
      applyEngineUi();
      refreshAvailability();
    }
    return;
  }
  rec.serverState = '';
}

applyEngineUi();
serverFromLink();
discoverServer(true);
document.addEventListener('visibilitychange', () => { if (!document.hidden) discoverServer(); });
