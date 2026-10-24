'use strict';

// ---------- Utilitaires ----------
const $ = (s) => document.querySelector(s);
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};
const arNum = (n) => n.toLocaleString('ar-EG');
const pad3 = (n) => String(n).padStart(3, '0');

// Normalise un mot arabe pour la comparaison : sans voyelles, sans signes coraniques,
// et avec les variantes de lettres ramenées à une seule forme.
function norm(w) {
  return w.normalize('NFC')
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ء/g, '')
    .replace(/[^ء-ي]/g, '');
}

function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Deux mots sont considérés identiques s'ils diffèrent d'au plus une part des lettres
// (1/3 en mode strict, ~1/2 en mode souple : la reconnaissance vocale n'est pas parfaite).
// Les mots très courts doivent être exacts.
function same(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) <= 2) return false;
  return lev(a, b) / Math.max(a.length, b.length) <= (rec.strict ? 0.34 : 0.5);
}

// ---------- Données ----------
let QURAN = [];
let current = null; // { surah, from, to }

async function loadData() {
  const res = await fetch('data/quran.json');
  QURAN = await res.json();
  renderList();
}

// ---------- Navigation ----------
const views = { home: $('#view-home'), learn: $('#view-learn'), recite: $('#view-recite') };

function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  if (name !== 'learn') { stopAudio(); stopRecording(); }
  if (name !== 'recite') stopListening();
  window.scrollTo(0, 0);
}

function go(name) {
  history.pushState({ v: name }, '');
  show(name);
}

window.addEventListener('popstate', (e) => show(e.state?.v || 'home'));
document.querySelectorAll('.back').forEach((b) => b.addEventListener('click', () => history.back()));

// ---------- Écran 1 : liste des sourates ----------
function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const qn = norm(q);
  const ul = $('#surah-list');
  ul.innerHTML = '';
  for (const s of QURAN) {
    if (q && !(String(s.n) === q || s.en.toLowerCase().includes(q) || (qn && norm(s.name).includes(qn)))) continue;
    const li = document.createElement('li');
    li.innerHTML = `<span class="num">${s.n}</span>
      <span class="info"><div class="en">${s.en}</div><div class="count">${s.a.length} versets</div></span>
      <span class="ar" dir="rtl">${s.name}</span>`;
    li.addEventListener('click', () => openPicker(s));
    ul.appendChild(li);
  }
}
$('#search').addEventListener('input', renderList);

// ---------- Choix des versets ----------
function openPicker(s) {
  const saved = store.get('range-' + s.n, null);
  const total = s.a.length;
  $('#picker-title').textContent = `${s.n}. ${s.en} — ${s.name}`;
  $('#from').max = $('#to').max = total;
  $('#from').value = saved ? saved[0] : 1;
  $('#to').value = saved ? saved[1] : Math.min(total, total <= 20 ? total : 10);
  current = { surah: s };
  $('#picker').hidden = false;
}

function readRange() {
  const s = current.surah, total = s.a.length;
  let from = Math.max(1, Math.min(total, parseInt($('#from').value, 10) || 1));
  let to = Math.max(1, Math.min(total, parseInt($('#to').value, 10) || total));
  if (to < from) [from, to] = [to, from];
  current.from = from;
  current.to = to;
  store.set('range-' + s.n, [from, to]);
  $('#picker').hidden = true;
}

const rangeTitle = () => `${current.surah.en} ${current.from}–${current.to}`;

$('#picker-close').addEventListener('click', () => { $('#picker').hidden = true; });
$('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker') $('#picker').hidden = true; });
$('#btn-learn').addEventListener('click', () => { readRange(); openLearn(); });
$('#btn-recite').addEventListener('click', () => { readRange(); openRecite(); });

// ---------- Écran 2 : apprendre ----------
const audio = new Audio();
let playlist = [], playIdx = 0;

$('#reciter').value = store.get('reciter', 'Husary_Muallim_128kbps');
$('#repeat').value = store.get('repeat', '3');
$('#reciter').addEventListener('change', () => store.set('reciter', $('#reciter').value));
$('#repeat').addEventListener('change', () => store.set('repeat', $('#repeat').value));

function openLearn() {
  const { surah, from, to } = current;
  $('#learn-title').textContent = rangeTitle();
  $('#learn-msg').hidden = true;
  const box = $('#learn-text');
  box.innerHTML = '';
  for (let n = from; n <= to; n++) {
    const span = document.createElement('span');
    span.className = 'ayah';
    span.dataset.n = n;
    span.innerHTML = `${surah.a[n - 1]} <span class="mark">﴿${arNum(n)}﴾</span> `;
    span.addEventListener('click', () => play([n]));
    box.appendChild(span);
  }
  go('learn');
}

function play(ayahs) {
  const rep = parseInt($('#repeat').value, 10);
  playlist = ayahs.flatMap((n) => Array(rep).fill(n));
  playIdx = 0;
  playNext();
}

async function playNext() {
  document.querySelectorAll('.ayah.playing').forEach((el) => el.classList.remove('playing'));
  if (playIdx >= playlist.length) { stopAudio(); return; }
  const n = playlist[playIdx];
  const reciter = $('#reciter').value;
  if (reciter === 'me') {
    const saved = await idbGet(`${current.surah.n}:${n}`);
    if (!playlist.length) return; // arrêté pendant la lecture de la base
    if (!saved) {
      showLearnMsg(`Verset ${n} pas encore enregistré avec votre voix.`);
      while (playIdx < playlist.length && playlist[playIdx] === n) playIdx++;
      playNext();
      return;
    }
    if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
    audio.src = URL.createObjectURL(new Blob([saved.buf], { type: saved.type }));
  } else {
    audio.src = `https://everyayah.com/data/${reciter}/${pad3(current.surah.n)}${pad3(n)}.mp3`;
  }
  audio.play().catch(() => stopAudio());
  const el = document.querySelector(`.ayah[data-n="${n}"]`);
  if (el) { el.classList.add('playing'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  $('#btn-play').textContent = '⏸ Pause';
}

function stopAudio() {
  audio.pause();
  playlist = [];
  document.querySelectorAll('.ayah.playing').forEach((el) => el.classList.remove('playing'));
  $('#btn-play').textContent = '▶ Écouter';
}

audio.addEventListener('ended', () => { playIdx++; playNext(); });
$('#btn-play').addEventListener('click', () => {
  if (playlist.length) { stopAudio(); return; }
  const all = [];
  for (let n = current.from; n <= current.to; n++) all.push(n);
  play(all);
});

function showLearnMsg(text) {
  $('#learn-msg').textContent = text;
  $('#learn-msg').hidden = false;
}

// ---------- Enregistrement de sa propre récitation (stocké dans le téléphone) ----------
const dbReady = new Promise((resolve, reject) => {
  try {
    const req = indexedDB.open('hifz', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('rec');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  } catch (e) { reject(e); }
});

async function idb(mode, fn) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('rec', mode);
    const req = fn(tx.objectStore('rec'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const idbGet = (key) => idb('readonly', (s) => s.get(key)).catch(() => undefined);
const idbPut = (key, val) => idb('readwrite', (s) => s.put(val, key));

const recording = { stream: null, recorder: null, n: 0 };

async function startRecording() {
  stopAudio();
  try {
    recording.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showLearnMsg('Accès au micro refusé.');
    return;
  }
  $('#learn-msg').hidden = true;
  $('#rec-bar').hidden = false;
  $('#btn-record').disabled = true;
  recordAyah(current.from);
}

function recordAyah(n) {
  document.querySelectorAll('.ayah.recording').forEach((el) => el.classList.remove('recording'));
  recording.n = n;
  const el = document.querySelector(`.ayah[data-n="${n}"]`);
  if (el) { el.classList.add('recording'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  $('#rec-label').textContent = `⏺ Verset ${n} : récitez puis touchez Suivant`;
  $('#rec-next').textContent = n >= current.to ? 'Terminer ✔' : 'Suivant ▶';

  const r = new MediaRecorder(recording.stream);
  const chunks = [];
  const key = `${current.surah.n}:${n}`;
  r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  r.onstop = async () => {
    if (r.discard || !chunks.length) return;
    const blob = new Blob(chunks, { type: r.mimeType });
    try { await idbPut(key, { buf: await blob.arrayBuffer(), type: r.mimeType }); }
    catch { showLearnMsg("Impossible d'enregistrer dans le téléphone (stockage plein ou bloqué)."); }
  };
  r.start();
  recording.recorder = r;
}

// Le verset en cours d'enregistrement est abandonné (l'ancien enregistrement est conservé).
function stopRecording() {
  if (recording.recorder && recording.recorder.state !== 'inactive') {
    recording.recorder.discard = true;
    recording.recorder.stop();
  }
  recording.recorder = null;
  if (recording.stream) recording.stream.getTracks().forEach((t) => t.stop());
  recording.stream = null;
  document.querySelectorAll('.ayah.recording').forEach((el) => el.classList.remove('recording'));
  $('#rec-bar').hidden = true;
  $('#btn-record').disabled = false;
}

$('#btn-record').addEventListener('click', startRecording);
$('#rec-stop').addEventListener('click', stopRecording);
$('#rec-next').addEventListener('click', () => {
  if (recording.recorder) { recording.recorder.stop(); recording.recorder = null; }
  if (recording.n >= current.to) {
    stopRecording();
    $('#reciter').value = 'me';
    store.set('reciter', 'me');
    showLearnMsg('Récitation enregistrée. « Ma récitation » est sélectionnée : touchez ▶ Écouter.');
  } else {
    recordAyah(recording.n + 1);
  }
});

// ---------- Écran 3 : réciter ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const rec = {
  words: [],        // { text, norm } pour chaque mot attendu
  spans: [],
  strict: store.get('severity', 'soft') === 'strict',
  committed: null,  // état validé (résultats finaux)
  shown: null,      // état affiché (peut inclure un résultat provisoire)
  base: null,       // état au début de la session d'écoute en cours
  offset: 0,        // mots de la session déjà intégrés à base (après un indice)
  heardCount: 0,    // nombre de mots entendus dans la session
  peeked: new Set(),// mots montrés automatiquement après une hésitation
  listening: false,
  recognition: null,
  lastProgress: 0,
  timer: null,
};

const newState = () => ({ pos: 0, marks: [], extra: 0 });
const clone = (st) => ({ pos: st.pos, marks: st.marks.slice(), extra: st.extra });

function openRecite() {
  const { surah, from, to } = current;
  $('#recite-title').textContent = rangeTitle();
  const box = $('#recite-text');
  box.innerHTML = '';
  rec.words = [];
  rec.spans = [];
  for (let n = from; n <= to; n++) {
    for (const t of surah.a[n - 1].split(/\s+/)) {
      const nw = norm(t);
      if (!nw) continue; // signes isolés (ex. ۞)
      const span = document.createElement('span');
      span.className = 'w';
      span.textContent = t;
      box.appendChild(span);
      box.appendChild(document.createTextNode(' '));
      rec.words.push({ text: t, norm: nw });
      rec.spans.push(span);
    }
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = `﴿${arNum(n)}﴾`;
    box.appendChild(mark);
    box.appendChild(document.createTextNode(' '));
  }
  $('#no-speech').hidden = !!SR;
  $('#btn-mic').disabled = !SR;
  resetRecite();
  go('recite');
}

function resetRecite() {
  stopListening();
  rec.committed = newState();
  rec.shown = rec.committed;
  newSession();
  rec.peeked.clear();
  $('#summary').hidden = true;
  $('#heard').textContent = '';
  render();
}

function markOk(st, j) { st.marks[j] = rec.peeked.has(j) ? 'hint' : 'ok'; }

// Mots sautés entre p et p+count. En mode souple, un seul mot sauté est souvent
// un mot que la reconnaissance n'a pas capté (récitation rapide) : il est « non entendu »
// (ou accepté si c'est un petit mot), pas compté comme erreur.
function markSkipped(st, p, count) {
  for (let j = p; j < p + count; j++) {
    if (rec.strict || count > 1) st.marks[j] = 'bad';
    else st.marks[j] = rec.words[j].norm.length <= 2 ? 'ok' : 'unsure';
  }
}

// Fait avancer l'état avec les mots entendus.
function align(st, heard) {
  const E = rec.words, N = E.length;
  for (let i = 0; i < heard.length && st.pos < N; i++) {
    const w = heard[i];
    const p = st.pos;
    if (w === E[p].norm) { markOk(st, p); st.pos++; st.extra = 0; continue; }
    // un mot exact un peu plus loin passe avant un mot seulement ressemblant ici
    // (ex. « لم يولد » ne doit pas valider « يلد »)
    let exact = 0;
    for (let k = 1; k <= 3 && p + k < N; k++) {
      if (E[p + k].norm.length >= 3 && w === E[p + k].norm) { exact = k; break; }
    }
    if (exact) {
      markSkipped(st, p, exact);
      markOk(st, p + exact);
      st.pos = p + exact + 1;
      st.extra = 0;
      continue;
    }
    if (same(w, E[p].norm)) { markOk(st, p); st.pos++; st.extra = 0; continue; }
    // deux mots attendus entendus collés
    if (p + 1 < N && same(w, E[p].norm + E[p + 1].norm)) {
      markOk(st, p); markOk(st, p + 1); st.pos += 2; st.extra = 0; continue;
    }
    // un mot attendu entendu en deux morceaux
    if (i + 1 < heard.length && same(w + heard[i + 1], E[p].norm)) {
      markOk(st, p); st.pos++; st.extra = 0; i++; continue;
    }
    // mot(s) sauté(s) : le mot entendu correspond à un mot un peu plus loin
    let skip = 0;
    for (let k = 1; k <= 3 && p + k < N; k++) {
      if (E[p + k].norm.length >= 3 && same(w, E[p + k].norm)) { skip = k; break; }
    }
    if (skip) {
      markSkipped(st, p, skip);
      markOk(st, p + skip);
      st.pos = p + skip + 1;
      st.extra = 0;
      continue;
    }
    // l'utilisateur répète un mot déjà récité : on l'ignore
    let repeated = false;
    for (let j = Math.max(0, p - 4); j < p; j++) if (same(w, E[j].norm)) { repeated = true; break; }
    if (repeated) continue;
    // mot inconnu : au 2e d'affilée (3e en souple), le mot attendu est compté comme erreur
    st.extra++;
    if (st.extra >= (rec.strict ? 2 : 3)) {
      st.marks[p] = 'bad';
      st.pos++;
      st.extra = 0;
      if (st.pos < N && same(w, E[st.pos].norm)) { markOk(st, st.pos); st.pos++; }
    }
  }
  return st;
}

function score(st) {
  let s = st.pos * 2;
  for (const m of st.marks) if (m === 'bad') s -= 3; else if (m === 'unsure') s -= 1;
  return s;
}

function render() {
  const st = rec.shown;
  rec.spans.forEach((el, i) => {
    let cls = 'w';
    if (i < st.pos) cls += ' ' + (st.marks[i] || 'ok');
    else if (i === st.pos && rec.peeked.has(i)) cls += ' peek current';
    else cls += ' hidden' + (i === st.pos ? ' current' : '');
    el.className = cls;
  });
  const cur = rec.spans[st.pos];
  if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (st.pos >= rec.words.length) finish();
}

function setShown(st, commit) {
  if (st.pos !== rec.shown.pos) rec.lastProgress = Date.now();
  rec.shown = st;
  if (commit) rec.committed = st;
  render();
}

function finish() {
  stopListening();
  const marks = rec.shown.marks;
  const ok = marks.filter((m) => m === 'ok').length;
  const bad = marks.filter((m) => m === 'bad').length;
  const hint = marks.filter((m) => m === 'hint').length;
  const unsure = marks.filter((m) => m === 'unsure').length;
  const pct = Math.round((ok / Math.max(1, rec.words.length - unsure)) * 100);
  $('#summary').innerHTML = `<b>${pct} %</b><br>✅ ${ok} correct · ❌ ${bad} erreur(s) · 💡 ${hint} indice(s)`
    + (unsure ? ` · ${unsure} non entendu(s)` : '');
  $('#summary').hidden = false;
}

// Texte entendu depuis le début de la session. Sur Android, un segment peut répéter
// le précédent en le complétant (« قل هو » puis « قل هو الله ») : on garde le plus long.
function sessionText(results, a) {
  const segs = [];
  for (const r of results) {
    const t = r[Math.min(a, r.length - 1)].transcript.trim();
    if (!t) continue;
    const prev = segs[segs.length - 1];
    if (prev && t.startsWith(prev)) segs[segs.length - 1] = t;
    else if (!(prev && prev.startsWith(t))) segs.push(t);
  }
  return segs.join(' ');
}

function onResult(e) {
  const results = Array.from(e.results);
  const isFinal = results[results.length - 1].isFinal;
  const nAlt = Math.max(...results.map((r) => r.length));
  let best = null, bestScore = -Infinity, bestText = '', bestCount = 0;
  for (let a = 0; a < nAlt; a++) {
    const text = sessionText(results, a);
    const heard = text.split(/\s+/).map(norm).filter(Boolean);
    const st = align(clone(rec.base), heard.slice(rec.offset));
    const sc = score(st);
    if (sc > bestScore) { best = st; bestScore = sc; bestText = text; bestCount = heard.length; }
  }
  rec.heardCount = bestCount;
  $('#heard').textContent = bestText.split(/\s+/).slice(-8).join(' ');
  setShown(best, isFinal);
}

function startListening() {
  if (!SR || rec.listening) return;
  if (rec.committed.pos >= rec.words.length) resetRecite();
  const r = new SR();
  r.lang = 'ar-SA';
  // Écoute continue : chaque redémarrage du micro fait un bip sur Android et perd
  // les mots prononcés pendant ce temps. On ne relance que si le navigateur coupe.
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 3;
  r.onresult = onResult;
  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      $('#heard').textContent = 'Accès au micro refusé.';
      stopListening();
    }
  };
  r.onend = () => {
    rec.committed = rec.shown; // garde le dernier résultat provisoire si aucun final n'est arrivé
    newSession();
    if (rec.listening) { try { r.start(); } catch { stopListening(); } }
  };
  newSession();
  rec.recognition = r;
  rec.listening = true;
  rec.lastProgress = Date.now();
  $('#btn-mic').classList.add('on');
  try { r.start(); } catch { stopListening(); }
  // après 5 s sans progression, le mot attendu apparaît en gris
  rec.timer = setInterval(() => {
    const p = rec.shown.pos;
    if (p < rec.words.length && !rec.peeked.has(p) && Date.now() - rec.lastProgress > 5000) {
      rec.peeked.add(p);
      render();
    }
  }, 500);
}

function stopListening() {
  rec.listening = false;
  clearInterval(rec.timer);
  if (rec.recognition) { try { rec.recognition.abort(); } catch { /* déjà arrêté */ } rec.recognition = null; }
  $('#btn-mic').classList.remove('on');
}

$('#btn-mic').addEventListener('click', () => (rec.listening ? stopListening() : startListening()));
$('#btn-restart').addEventListener('click', resetRecite);
function newSession() {
  rec.base = clone(rec.committed);
  rec.offset = 0;
  rec.heardCount = 0;
}

$('#btn-hint').addEventListener('click', () => {
  const st = clone(rec.shown);
  if (st.pos >= rec.words.length) return;
  st.marks[st.pos] = 'hint';
  st.pos++;
  st.extra = 0;
  // la session continue : les mots déjà entendus sont considérés comme traités
  rec.base = clone(st);
  rec.offset = rec.heardCount;
  setShown(st, true);
});

$('#severity').value = rec.strict ? 'strict' : 'soft';
$('#severity').addEventListener('change', () => {
  rec.strict = $('#severity').value === 'strict';
  store.set('severity', $('#severity').value);
});

// ---------- Démarrage ----------
loadData();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js');
}
