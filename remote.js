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
    node.port.onmessage = (e) => { if (mic.sink) mic.sink(e.data); };
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
}

class ServerRecognizer {
  constructor(url) {
    this.url = url;
    this.continuous = true;
    this.ws = null;
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
    try { ws = new WebSocket(this.url); } catch { this.fail('network'); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    let opened = false;
    ws.onopen = () => {
      opened = true;
      mic.sink = (buf) => { if (ws.readyState === 1) ws.send(buf.buffer); };
      if (this.onstart) this.onstart();
      if (this.onaudiostart) this.onaudiostart();
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const results = (msg.segments || []).map((s) => Object.assign([{ transcript: s.text, confidence: 1 }], { isFinal: s.final }));
      if (results.length && this.onresult) this.onresult({ results, resultIndex: 0 });
    };
    ws.onerror = () => { if (!opened) this.fail('network'); };
    ws.onclose = () => {
      if (mic.sink && this.ws === ws) mic.sink = null;
      if (!opened) { this.fail('network'); return; }
      this.end();
    };
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

  abort() {
    mic.sink = null;
    if (this.ws) { try { this.ws.close(); } catch { /* déjà fermé */ } }
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
applyEngineUi();
