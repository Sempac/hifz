'use strict';

// ---------- Labo : reconnaissance avec voyelles, entièrement dans le téléphone ----------
// Modèle Whisper entraîné sur le Coran (Tarteel), converti pour le navigateur.
// Le micro est enregistré directement (pas de reconnaissance du navigateur, donc pas de bip),
// puis analysé une fois l'enregistrement terminé.

const LABO_MODEL = 'YunusZJ/whisper-base-ar-quran-ONNX';
const LABO_LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

const labo = { asr: null, device: '', stream: null, recorder: null, chunks: [] };

const LMARKS = { 'َ': 'a', 'ُ': 'u', 'ِ': 'i', 'ً': 'an', 'ٌ': 'un', 'ٍ': 'in', 'ّ': '~' };

// squelette d'un mot (le modèle peut écrire « الَّهُ » pour « اللَّهُ »)
const skel = (w) => { const n = norm(w); return n === 'اله' ? 'الله' : n; };

// lettres de base du mot, chacune avec ses voyelles
function laboSlots(word) {
  const out = [];
  for (const c of word.normalize('NFC')) {
    const last = out[out.length - 1];
    if (norm(c) || !last) out.push({ raw: c, v: [] });
    else {
      last.raw += c; // signe attaché à la lettre précédente (gardé pour l'affichage)
      if (LMARKS[c]) last.v.push(LMARKS[c]);
    }
  }
  return out.map((s) => ({ raw: s.raw, v: s.v.filter((x) => x !== '~').sort().join('') }));
}

// Associe les lettres de deux écritures d'un même mot (une lettre peut manquer d'un côté,
// ex. « الَّهُ » pour « اللَّهُ ») : pair[k] = indice dans b de la lettre k de a.
function alignSlots(a, b) {
  const L = (s) => norm(s.raw) || s.raw;
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = L(a[i]) === L(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const pair = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (L(a[i]) === L(b[j]) && dp[i][j] === dp[i + 1][j + 1] + 1) { pair[i] = j; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return pair;
}

// Compare le texte attendu et le texte entendu : mots (squelette) puis voyelles.
function laboCompare(refText, hypText) {
  const R = refText.split(/\s+/).filter((w) => norm(w));
  const H = hypText.split(/\s+/).filter((w) => norm(w));
  const n = R.length, m = H.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = skel(R[i]) === skel(H[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const words = R.map((w) => ({ ref: w, hyp: null, bad: [] }));
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (skel(R[i]) === skel(H[j])) { words[i].hyp = H[j]; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  let vTotal = 0, vOk = 0;
  words.forEach((w, wi) => {
    if (!w.hyp) return;
    const a = laboSlots(w.ref), b = laboSlots(w.hyp);
    const pair = alignSlots(a, b);
    a.forEach((s, k) => {
      if (wi === n - 1 && k === a.length - 1) return; // pause en fin de verset : voyelle finale non prononcée
      if (!s.v || pair[k] === undefined) return;
      vTotal++;
      if (s.v === b[pair[k]].v) vOk++; else w.bad.push(k);
    });
  });
  return { words, matched: words.filter((w) => w.hyp).length, total: n, vTotal, vOk };
}

function laboRenderCompare(res) {
  const box = $('#labo-compare');
  box.innerHTML = '';
  for (const w of res.words) {
    const span = document.createElement('span');
    span.className = 'lw ' + (!w.hyp ? 'missing' : w.bad.length ? 'vowel' : 'ok');
    if (w.bad.length) {
      const slots = laboSlots(w.ref);
      // la lettre dont la voyelle diffère est surlignée ; le mot entendu est affiché dessous
      slots.forEach((s, k) => {
        if (w.bad.includes(k)) {
          const b = document.createElement('span');
          b.className = 'bad-letter';
          b.textContent = s.raw;
          span.appendChild(b);
        } else span.appendChild(document.createTextNode(s.raw));
      });
      const small = document.createElement('small');
      small.textContent = w.hyp;
      span.appendChild(small);
    } else {
      span.textContent = w.ref;
    }
    box.appendChild(span);
    box.appendChild(document.createTextNode(' '));
  }
}

// ---------- Interface ----------
function laboRef() {
  const s = QURAN[+$('#labo-surah').value - 1];
  const n = Math.max(1, Math.min(s.a.length, +$('#labo-ayah').value || 1));
  $('#labo-ayah').max = s.a.length;
  $('#labo-ayah').value = n;
  return s.a[n - 1];
}

function laboShowRef() {
  $('#labo-ref').textContent = laboRef();
  $('#labo-result').hidden = true;
}

function openLabo() {
  const sel = $('#labo-surah');
  if (!sel.options.length) {
    for (const s of QURAN) sel.add(new Option(`${s.n}. ${s.en} — ${s.name}`, s.n));
    sel.value = store.get('labo-surah', 112);
    $('#labo-ayah').value = store.get('labo-ayah', 1);
  }
  laboShowRef();
  go('labo');
}

const laboStatus = (t) => { $('#labo-status').textContent = t; };

async function laboLoad() {
  $('#labo-load').disabled = true;
  try {
    laboStatus('Chargement de la bibliothèque…');
    const { pipeline, env } = await import(LABO_LIB);
    env.allowLocalModels = false;
    const want = $('#labo-device').value;
    const devices = want === 'auto' ? (navigator.gpu ? ['webgpu', 'wasm'] : ['wasm']) : [want];
    const files = {};
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.total) {
        files[p.file] = [p.loaded, p.total];
        const done = Object.values(files).reduce((a, f) => a + f[0], 0);
        const all = Object.values(files).reduce((a, f) => a + f[1], 0);
        laboStatus(`Téléchargement du modèle : ${(done / 1e6).toFixed(0)} / ${(all / 1e6).toFixed(0)} Mo`);
      }
    };
    let lastErr;
    for (const device of devices) {
      try {
        const t0 = performance.now();
        labo.asr = await pipeline('automatic-speech-recognition', LABO_MODEL, {
          dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, device, progress_callback,
        });
        labo.device = device;
        laboStatus(`Modèle prêt (${device === 'webgpu' ? 'carte graphique' : 'processeur'}, ${((performance.now() - t0) / 1000).toFixed(1)} s). Touchez 🎤, récitez le verset, puis touchez à nouveau.`);
        $('#labo-mic').disabled = false;
        return;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  } catch (e) {
    laboStatus('Échec du chargement : ' + (e?.message || e));
    $('#labo-load').disabled = false;
  }
}

async function laboStart() {
  try {
    labo.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    laboStatus('Accès au micro refusé.');
    return;
  }
  labo.chunks = [];
  labo.recorder = new MediaRecorder(labo.stream);
  labo.recorder.ondataavailable = (e) => { if (e.data.size) labo.chunks.push(e.data); };
  labo.recorder.onstop = laboAnalyse;
  labo.recorder.start();
  $('#labo-mic').classList.add('on');
  $('#labo-result').hidden = true;
  laboStatus('⏺ Enregistrement… touchez 🎤 quand vous avez fini le verset.');
}

function stopLabo() {
  if (labo.recorder && labo.recorder.state !== 'inactive') { labo.recorder.onstop = null; labo.recorder.stop(); }
  laboReleaseMic();
}
window.stopLabo = stopLabo;

function laboReleaseMic() {
  if (labo.stream) labo.stream.getTracks().forEach((t) => t.stop());
  labo.stream = null;
  labo.recorder = null;
  $('#labo-mic').classList.remove('on');
}

// Audio enregistré → échantillons mono à 16 kHz (format attendu par Whisper).
async function to16k(blob) {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const decoded = await ctx.decodeAudioData(buf);
  ctx.close();
  if (decoded.sampleRate === 16000) return decoded.getChannelData(0);
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

async function laboAnalyse() {
  const type = labo.recorder.mimeType;
  laboReleaseMic();
  $('#labo-mic').disabled = true;
  try {
    laboStatus('Analyse en cours…');
    const audio = await to16k(new Blob(labo.chunks, { type }));
    await new Promise((r) => setTimeout(r, 50)); // laisse l'écran se mettre à jour
    const t0 = performance.now();
    const out = await labo.asr(audio, { language: 'arabic', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    const sec = (performance.now() - t0) / 1000;
    const heard = out.text.trim();
    const res = laboCompare(laboRef(), heard);
    $('#labo-heard').textContent = heard || '(rien entendu)';
    laboRenderCompare(res);
    $('#labo-stats').innerHTML =
      `Mots reconnus : <b>${res.matched}/${res.total}</b> · Voyelles justes : <b>${res.vOk}/${res.vTotal}</b><br>` +
      `Récitation : ${(audio.length / 16000).toFixed(1)} s · Calcul : <b>${sec.toFixed(1)} s</b> ` +
      `(${labo.device === 'webgpu' ? 'carte graphique' : 'processeur'})`;
    $('#labo-result').hidden = false;
    laboStatus('Touchez 🎤 pour recommencer.');
  } catch (e) {
    laboStatus("Échec de l'analyse : " + (e?.message || e));
  }
  $('#labo-mic').disabled = false;
}

$('#btn-labo').addEventListener('click', () => { if (QURAN.length) openLabo(); });
$('#labo-surah').addEventListener('change', () => {
  $('#labo-ayah').value = 1;
  store.set('labo-surah', +$('#labo-surah').value);
  laboShowRef();
});
$('#labo-ayah').addEventListener('change', () => { laboShowRef(); store.set('labo-ayah', +$('#labo-ayah').value); });
$('#labo-load').addEventListener('click', laboLoad);
$('#labo-mic').addEventListener('click', () => (labo.stream ? labo.recorder.stop() : laboStart()));
