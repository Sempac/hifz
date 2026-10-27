'use strict';

// ---------- Entraîner sur ma voix : enregistrements pour affiner le modèle ----------
// Chaque verset lu est enregistré en son brut (16 kHz mono, comme le mode serveur, via le micro de
// remote.js) et gardé dans le téléphone (IndexedDB, magasin « train ») avec son texte.
// « Exporter » rassemble tout dans un .zip : audio/*.wav + metadata.jsonl, prêt pour l'entraînement.

const train = { active: false, chunks: [], lastId: null, player: new Audio() };
const MIN_SEC = 0.5; // en dessous : toucher par erreur, pas enregistré

const trainStats = () => store.get('train-stats', { n: 0, sec: 0, expN: 0, expSec: 0 });
const tidb = (mode, fn) => idb(mode, fn, 'train');

function trainVerse() {
  const s = QURAN[+$('#train-surah').value - 1];
  const a = Math.max(1, Math.min(s.a.length, +$('#train-ayah').value || 1));
  $('#train-ayah').max = s.a.length;
  $('#train-ayah').value = a;
  return { s: s.n, a };
}

function trainShowVerse() {
  const x = trainVerse();
  $('#train-ref').innerHTML = `${ayahText(x)} <span class="mark">﴿${arNum(x.a)}﴾</span>`;
  store.set('train-pos', [x.s, x.a]);
}

function trainGoto(x) {
  $('#train-surah').value = x.s;
  $('#train-ayah').value = x.a;
  trainShowVerse();
}

// Verset suivant (la sourate suivante après le dernier verset)
function trainAdvance() {
  const x = trainVerse();
  if (x.a < QURAN[x.s - 1].a.length) trainGoto({ s: x.s, a: x.a + 1 });
  else if (x.s < 114) trainGoto({ s: x.s + 1, a: 1 });
}

const fmtDur = (sec) => (sec < 60 ? `${Math.round(sec)} s` : `${Math.floor(sec / 60)} min ${String(Math.round(sec % 60)).padStart(2, '0')}`);

function trainRenderStats() {
  const t = trainStats();
  const left = t.n - t.expN;
  $('#train-stats').textContent = t.n
    ? `${t.n} versets enregistrés · ${fmtDur(t.sec)} au total` + (t.expN ? ` · ${left} pas encore exportés` : '')
    : 'Aucun enregistrement pour le moment.';
  $('#train-export').disabled = !t.n;
  $('#train-clear').disabled = !t.expN;
  $('#train-play').disabled = !train.lastId;
}

const trainStatus = (t) => { $('#train-status').textContent = t; };

function trainUi() {
  $('#train-mic').classList.toggle('on', train.active);
  $('#train-mic').textContent = train.active ? '✔' : '🎤';
  $('#train-stop').disabled = !train.active;
  $('#train-redo').disabled = !train.active && !train.lastId;
  $('#train-surah').disabled = $('#train-ayah').disabled = train.active;
  trainRenderStats();
}

function openTrain() {
  const sel = $('#train-surah');
  if (!sel.options.length) {
    for (const s of QURAN) sel.add(new Option(`${s.n}. ${s.en} — ${s.name}`, s.n));
    const [s, a] = store.get('train-pos', [1, 1]);
    sel.value = s;
    $('#train-ayah').value = a;
  }
  trainShowVerse();
  trainUi();
  go('train');
}

function trainBegin() {
  train.chunks = [];
  mic.sink = (buf) => train.chunks.push(buf);
}

async function trainStart() {
  try {
    await ensureMic();
  } catch {
    trainStatus('Accès au micro refusé.');
    return;
  }
  // demande au téléphone de ne pas effacer ces données quand l'espace manque
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  train.active = true;
  trainBegin();
  trainStatus('⏺ Lisez le verset, puis touchez ✔ pour passer au suivant.');
  trainUi();
}

// Enregistre le verset en cours ; renvoie false s'il est trop court
async function trainSave() {
  const chunks = train.chunks;
  train.chunks = [];
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const dur = len / 16000;
  if (dur < MIN_SEC) return false;
  const pcm = new Int16Array(len);
  let off = 0;
  for (const c of chunks) { pcm.set(c, off); off += c.length; }
  const x = trainVerse();
  const rec = { s: x.s, a: x.a, text: ayahText(x), pcm: pcm.buffer, dur, date: Date.now() };
  try {
    train.lastId = await tidb('readwrite', (st) => st.add(rec));
    train.lastDur = dur;
    train.lastVerse = x;
  } catch {
    trainStatus("Impossible d'enregistrer dans le téléphone (stockage plein ou bloqué).");
    return false;
  }
  const t = trainStats();
  t.n++; t.sec += dur;
  store.set('train-stats', t);
  return true;
}

async function trainNext() {
  const x = trainVerse();
  mic.sink = null;
  const ok = await trainSave();
  if (!train.active) return;
  if (ok) trainAdvance();
  trainBegin();
  trainStatus(ok ? `✔ ${QURAN[x.s - 1].en} ${x.a} enregistré. Verset suivant…` : 'Trop court, pas enregistré. Lisez le verset.');
  trainUi();
}

// Arrêt : le verset en cours (inachevé) n'est pas gardé
function trainStop() {
  train.active = false;
  train.chunks = [];
  releaseMic();
  trainStatus('Arrêté. Touchez 🎤 pour reprendre.');
  trainUi();
}
window.stopTrain = () => { if (train.active) trainStop(); };

// Refaire : pendant l'enregistrement, recommence le verset en cours ;
// à l'arrêt, supprime le dernier verset enregistré et revient dessus.
async function trainRedo() {
  if (train.active) {
    trainBegin();
    trainStatus('↺ On recommence ce verset depuis le début.');
    return;
  }
  if (!train.lastId) return;
  const id = train.lastId;
  await tidb('readwrite', (st) => st.delete(id)).catch(() => {});
  const t = trainStats();
  t.n--; t.sec -= train.lastDur;
  if (id <= store.get('train-exported', 0)) { t.expN--; t.expSec -= train.lastDur; }
  store.set('train-stats', t);
  train.lastId = null;
  trainGoto(train.lastVerse);
  trainStatus('Dernier enregistrement supprimé. Touchez 🎤 pour relire ce verset.');
  trainUi();
}

// ---------- Fichiers WAV et ZIP (sans compression, l'audio ne se compresse presque pas) ----------
function wavHeader(bytes) {
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); h.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, 16000, true); h.setUint32(28, 32000, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  str(36, 'data'); h.setUint32(40, bytes, true);
  return new Uint8Array(h.buffer);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(parts) {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files : [{ name, parts: [Uint8Array] }] → Blob .zip
function makeZip(files) {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const enc = new TextEncoder();
  const out = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const size = f.parts.reduce((n, p) => n + p.length, 0);
    const crc = crc32(f.parts);
    const loc = new DataView(new ArrayBuffer(30));
    loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint16(6, 0x0800, true);
    loc.setUint16(10, time, true); loc.setUint16(12, date, true); loc.setUint32(14, crc, true);
    loc.setUint32(18, size, true); loc.setUint32(22, size, true); loc.setUint16(26, name.length, true);
    out.push(loc.buffer, name, ...f.parts);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true); cen.setUint16(12, time, true); cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, size, true); cen.setUint32(24, size, true);
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(cen.buffer, name);
    offset += 30 + name.length + size;
  }
  const cenSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...out, ...central, end.buffer], { type: 'application/zip' });
}

async function trainExport() {
  $('#train-export').disabled = true;
  trainStatus('Préparation du fichier…');
  try {
    const keys = await tidb('readonly', (st) => st.getAllKeys());
    const recs = await tidb('readonly', (st) => st.getAll());
    const files = [], meta = [];
    recs.forEach((r, i) => {
      const name = `audio/${String(keys[i]).padStart(6, '0')}_${pad3(r.s)}-${pad3(r.a)}.wav`;
      const pcm = new Uint8Array(r.pcm);
      files.push({ name, parts: [wavHeader(pcm.length), pcm] });
      meta.push(JSON.stringify({
        file: name, surah: r.s, ayah: r.a, text: r.text, duration: +r.dur.toFixed(2), date: new Date(r.date).toISOString(),
      }));
    });
    files.push({ name: 'metadata.jsonl', parts: [new TextEncoder().encode(meta.join('\n') + '\n')] });
    const blob = makeZip(files);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hifz-voix-${stamp}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    // tout ce qui est dans le fichier peut ensuite être effacé du téléphone
    const t = trainStats();
    t.expN = t.n; t.expSec = t.sec;
    store.set('train-stats', t);
    store.set('train-exported', Math.max(0, ...keys));
    trainStatus(`Fichier ${a.download} créé (${(blob.size / 1e6).toFixed(0)} Mo). Copiez-le sur le PC.`);
  } catch (e) {
    trainStatus("Échec de l'export : " + (e?.message || e));
  }
  trainUi();
}

// Efface du téléphone les enregistrements déjà exportés (deuxième toucher pour confirmer)
let clearArmed = null;
async function trainClear() {
  const t = trainStats();
  if (!clearArmed) {
    $('#train-clear').textContent = `Confirmer : effacer ${t.expN} ?`;
    clearArmed = setTimeout(() => { clearArmed = null; $('#train-clear').textContent = '🗑 Effacer les exportés'; }, 4000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  $('#train-clear').textContent = '🗑 Effacer les exportés';
  const max = store.get('train-exported', 0);
  try {
    await tidb('readwrite', (st) => st.delete(IDBKeyRange.upperBound(max)));
  } catch {
    trainStatus("Impossible d'effacer.");
    return;
  }
  t.n -= t.expN; t.sec -= t.expSec; t.expN = 0; t.expSec = 0;
  store.set('train-stats', t);
  if (train.lastId && train.lastId <= max) train.lastId = null;
  trainStatus('Enregistrements exportés effacés du téléphone.');
  trainUi();
}

async function trainPlay() {
  const r = train.lastId && await tidb('readonly', (st) => st.get(train.lastId)).catch(() => null);
  if (!r) return;
  const pcm = new Uint8Array(r.pcm);
  if (train.player.src.startsWith('blob:')) URL.revokeObjectURL(train.player.src);
  train.player.src = URL.createObjectURL(new Blob([wavHeader(pcm.length), pcm], { type: 'audio/wav' }));
  train.player.play().catch(() => {});
}

$('#btn-train').addEventListener('click', () => { if (QURAN.length) openTrain(); });
$('#train-surah').addEventListener('change', () => { $('#train-ayah').value = 1; trainShowVerse(); });
$('#train-ayah').addEventListener('change', trainShowVerse);
$('#train-mic').addEventListener('click', () => (train.active ? trainNext() : trainStart()));
$('#train-stop').addEventListener('click', trainStop);
$('#train-redo').addEventListener('click', trainRedo);
$('#train-play').addEventListener('click', trainPlay);
$('#train-export').addEventListener('click', trainExport);
$('#train-clear').addEventListener('click', trainClear);
