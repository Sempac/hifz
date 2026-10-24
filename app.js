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

// Niveaux de correction (1 = très stricte … 5 = très souple) :
//   tol      part maximale de lettres différentes pour accepter un mot
//   extra    nombre de mots inconnus d'affilée avant de compter le mot attendu comme erreur
//   unsure   nombre de mots sautés d'affilée affichés « non entendu » au lieu d'erreur
//   shortOk  un petit mot (1-2 lettres) sauté seul est accepté
const LEVELS = {
  1: { tol: 0.25, extra: 2, unsure: 0, shortOk: false },
  2: { tol: 0.34, extra: 2, unsure: 0, shortOk: false },
  3: { tol: 0.42, extra: 3, unsure: 1, shortOk: false },
  4: { tol: 0.5, extra: 3, unsure: 1, shortOk: true },
  5: { tol: 0.58, extra: 4, unsure: 2, shortOk: true },
};

// Deux mots sont considérés identiques s'ils diffèrent d'au plus une part des lettres
// (la reconnaissance vocale n'est pas parfaite). Les mots très courts doivent être exacts.
function same(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) <= 2) return false;
  return lev(a, b) / Math.max(a.length, b.length) <= LEVELS[rec.level].tol;
}

// Ce que la reconnaissance comprend pour un mot donné chez cet utilisateur,
// appris quand il touche un mot marqué faux à tort : { motAttendu: [motsEntendus] }
const learned = store.get('learned', {});
const isLearned = (heard, expected) => !!learned[expected]?.includes(heard);

// ---------- Données ----------
let QURAN = [];
let current = null; // { surah, from, to }

// Position de chaque mot dans l'audio mot par mot de Quran.com, pour les versets
// où son découpage diffère du nôtre : { "sourate:verset": [positions] }
let WBW = {};

async function loadData() {
  const res = await fetch('data/quran.json');
  QURAN = await res.json();
  renderList();
  WBW = await fetch('data/wbw.json').then((r) => r.json()).catch(() => ({}));
}

function wordAudioUrl(w) {
  const pos = WBW[`${current.surah.n}:${w.ayah}`]?.[w.k] ?? w.k + 1;
  return `https://audio.qurancdn.com/wbw/${pad3(current.surah.n)}_${pad3(w.ayah)}_${pad3(pos)}.mp3`;
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
  level: store.get('level', store.get('severity', 'soft') === 'strict' ? 2 : 4),
  overrides: new Set(), // mots marqués justes à la main par l'utilisateur
  replay: store.get('replay', true), // reprise sur erreur
  retries: {},          // mot → nombre de reprises
  pausing: false,       // micro coupé le temps de faire entendre un mot
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

// pending : mots entendus non reconnus depuis le dernier mot juste
// heard   : pour un mot compté faux, ce que la reconnaissance a entendu à sa place
const newState = () => ({ pos: 0, marks: [], extra: 0, pending: [], heard: {} });
const clone = (st) => ({ pos: st.pos, marks: st.marks.slice(), extra: st.extra, pending: st.pending.slice(), heard: { ...st.heard } });

function openRecite() {
  const { surah, from, to } = current;
  $('#recite-title').textContent = rangeTitle();
  const box = $('#recite-text');
  box.innerHTML = '';
  rec.words = [];
  rec.spans = [];
  for (let n = from; n <= to; n++) {
    let k = 0;
    for (const t of surah.a[n - 1].split(/\s+/)) {
      const nw = norm(t);
      if (!nw) continue; // signes isolés (ex. ۞)
      const span = document.createElement('span');
      span.className = 'w';
      span.textContent = t;
      const idx = rec.words.length;
      span.addEventListener('click', () => acceptWord(idx));
      box.appendChild(span);
      box.appendChild(document.createTextNode(' '));
      rec.words.push({ text: t, norm: nw, ayah: n, k: k++ });
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
  rec.overrides.clear();
  rec.retries = {};
  $('#summary').hidden = true;
  $('#heard').textContent = '';
  render();
}

function markOk(st, j) {
  st.marks[j] = rec.peeked.has(j) ? 'hint' : rec.retries[j] ? 'fixed' : 'ok';
}

// Le mot j est juste : on avance juste après.
function advanceOk(st, j) {
  markOk(st, j);
  st.pos = j + 1;
  st.extra = 0;
  st.pending = [];
}

// Mots sautés entre p et p+count. Selon le niveau, quelques mots sautés sont souvent
// des mots que la reconnaissance n'a pas captés (récitation rapide) : ils sont
// « non entendu » (ou acceptés si c'est un petit mot), pas comptés comme erreur.
function markSkipped(st, p, count) {
  const L = LEVELS[rec.level];
  for (let j = p; j < p + count; j++) {
    if (count > L.unsure) st.marks[j] = 'bad';
    // avec le rappel, un petit mot oublié doit aussi être repris
    else if (count === 1 && L.shortOk && !rec.replay && rec.words[j].norm.length <= 2) st.marks[j] = 'ok';
    else st.marks[j] = 'unsure';
  }
}

// Fait avancer l'état avec les mots entendus.
function align(st, heard) {
  const E = rec.words, N = E.length;
  for (let i = 0; i < heard.length && st.pos < N; i++) {
    const w = heard[i];
    const p = st.pos;
    if (w === E[p].norm || isLearned(w, E[p].norm)) { advanceOk(st, p); continue; }
    // un mot exact un peu plus loin passe avant un mot seulement ressemblant ici
    // (ex. « لم يولد » ne doit pas valider « يلد »)
    let exact = 0;
    for (let k = 1; k <= 3 && p + k < N; k++) {
      if (E[p + k].norm.length >= 3 && w === E[p + k].norm) { exact = k; break; }
    }
    if (exact) { markSkipped(st, p, exact); advanceOk(st, p + exact); continue; }
    if (same(w, E[p].norm)) { advanceOk(st, p); continue; }
    // deux mots attendus entendus collés
    if (p + 1 < N && same(w, E[p].norm + E[p + 1].norm)) { markOk(st, p); advanceOk(st, p + 1); continue; }
    // un mot attendu entendu en deux morceaux
    if (i + 1 < heard.length && same(w + heard[i + 1], E[p].norm)) { advanceOk(st, p); i++; continue; }
    // mot(s) sauté(s) : le mot entendu correspond à un mot un peu plus loin
    let skip = 0;
    for (let k = 1; k <= 3 && p + k < N; k++) {
      if (E[p + k].norm.length >= 3 && same(w, E[p + k].norm)) { skip = k; break; }
    }
    if (skip) { markSkipped(st, p, skip); advanceOk(st, p + skip); continue; }
    // l'utilisateur répète un mot déjà récité : on l'ignore
    let repeated = false;
    for (let j = Math.max(0, p - 4); j < p; j++) if (same(w, E[j].norm)) { repeated = true; break; }
    if (repeated) continue;
    // mot inconnu : au bout de quelques-uns d'affilée, le mot attendu est compté comme erreur
    st.extra++;
    st.pending.push(w);
    if (st.extra >= LEVELS[rec.level].extra) {
      st.marks[p] = 'bad';
      st.heard[p] = st.pending;
      st.pos++;
      st.extra = 0;
      st.pending = [];
      if (st.pos < N && same(w, E[st.pos].norm)) {
        st.heard[p] = st.heard[p].slice(0, -1); // w appartenait au mot suivant
        advanceOk(st, st.pos);
      }
    }
  }
  return st;
}

// L'utilisateur touche un mot marqué faux à tort : il devient juste, et ce que
// la reconnaissance avait entendu à sa place sera accepté la prochaine fois.
function acceptWord(i) {
  const m = rec.shown.marks[i];
  if (i >= rec.shown.pos || rec.overrides.has(i) || (m !== 'bad' && m !== 'unsure')) return;
  rec.overrides.add(i);
  const exp = rec.words[i].norm;
  const heard = (rec.shown.heard[i] || []).filter((h) => h !== exp);
  if (heard.length) {
    learned[exp] = [...new Set([...(learned[exp] || []), ...heard])];
    store.set('learned', learned);
    $('#heard').textContent = `Retenu : « ${heard.join(' ')} » sera accepté pour « ${rec.words[i].text} ».`;
  }
  render();
  if (!$('#summary').hidden) finish(); // met à jour le score
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
    if (i < st.pos) cls += ' ' + markOf(st, i);
    else if (i === st.pos && rec.peeked.has(i)) cls += ' peek current';
    else cls += ' hidden' + (i === st.pos ? ' current' : '');
    el.className = cls;
  });
  const cur = rec.spans[st.pos];
  if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function setShown(st, commit) {
  if (st.pos !== rec.shown.pos) rec.lastProgress = Date.now();
  rec.shown = st;
  if (commit) rec.committed = st;
  // le rappel passe avant la fin : une erreur sur le dernier mot doit aussi être reprise
  if (commit && checkReplay(st)) return;
  render();
  if (commit && st.pos >= rec.words.length) finish();
}

// ---------- Reprise sur erreur ----------
// Sur une erreur, le micro se coupe, l'application récite le passage qui précède
// (depuis le début du verset, 6 mots au plus) jusqu'au dernier mot juste, puis
// l'utilisateur reprend au mot faux (2 reprises maximum par mot).
const RAPPEL_MAX = 6;
// Un seul lecteur pour tous les rappels : l'iPhone n'autorise un lecteur à jouer seul
// (sans toucher l'écran) que s'il a déjà joué une fois suite à un toucher.
const sayEl = new Audio();
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
let sayAudio = null;

// À appeler pendant un toucher (bouton micro) pour autoriser les rappels sur iPhone.
function unlockSayAudio() {
  sayEl.onended = sayEl.onerror = null;
  sayEl.src = SILENCE;
  sayEl.play().catch(() => { /* rien à jouer */ });
}

// Indices des mots à réciter avant le mot i.
function rappelWords(i) {
  const last = i - 1;
  let s = last;
  while (s > 0 && rec.words[s - 1].ayah === rec.words[last].ayah && last - s < RAPPEL_MAX - 1) s--;
  const out = [];
  for (let j = s; j <= last; j++) out.push(j);
  return out;
}

// Récite les mots un par un (audio mot par mot), en les surlignant.
function sayWords(idxs, done) {
  const urls = idxs.map((j) => wordAudioUrl(rec.words[j]));
  // préchargement pour réduire les blancs entre les mots
  urls.forEach((u) => { const a = new Audio(); a.preload = 'auto'; a.src = u; });
  let n = 0;
  const next = () => {
    document.querySelectorAll('.w.say').forEach((el) => el.classList.remove('say'));
    if (!rec.pausing || n >= urls.length) { sayAudio = null; done(); return; }
    rec.spans[idxs[n]].classList.add('say');
    sayAudio = sayEl;
    sayEl.onended = next;
    sayEl.onerror = next;
    sayEl.src = urls[n++];
    sayEl.play().catch(next);
  };
  next();
}

// Un mot faux ou « non entendu » (souvent un oubli) déclenche le rappel.
function checkReplay(st) {
  if (!rec.replay || !rec.listening || rec.pausing) return false;
  for (let i = 0; i < st.pos; i++) {
    const m = markOf(st, i);
    if ((m === 'bad' || m === 'unsure') && (rec.retries[i] || 0) < 2) { replayAt(i); return true; }
  }
  return false;
}

function replayAt(i) {
  rec.pausing = true;
  rec.retries[i] = (rec.retries[i] || 0) + 1;
  const r = rec.recognition;
  rec.recognition = null;
  if (r) { try { r.abort(); } catch { /* déjà arrêté */ } }

  const st = clone(rec.shown);
  st.pos = i;
  st.marks.length = i;
  st.extra = 0;
  st.pending = [];
  for (const k of Object.keys(st.heard)) if (Number(k) >= i) delete st.heard[k];
  rec.shown = rec.committed = st;
  newSession();
  render();

  const resume = () => {
    if (!rec.pausing) return;
    rec.pausing = false;
    if (rec.listening) { rec.lastProgress = Date.now(); startRecognizer(); }
  };
  if (i > 0) {
    $('#heard').textContent = 'Écoutez le rappel, puis continuez au mot suivant.';
    sayWords(rappelWords(i), resume);
  } else {
    $('#heard').textContent = 'Erreur sur le premier mot : reprenez.';
    setTimeout(resume, 500);
  }
}

const markOf = (st, i) => (rec.overrides.has(i) ? 'ok' : st.marks[i] || 'ok');

function finish() {
  stopListening();
  const marks = rec.words.map((_, i) => markOf(rec.shown, i));
  const ok = marks.filter((m) => m === 'ok').length;
  const bad = marks.filter((m) => m === 'bad').length;
  const hint = marks.filter((m) => m === 'hint').length;
  const unsure = marks.filter((m) => m === 'unsure').length;
  const fixed = marks.filter((m) => m === 'fixed').length;
  const pct = Math.round((ok / Math.max(1, rec.words.length - unsure)) * 100);
  $('#summary').innerHTML = `<b>${pct} %</b><br>✅ ${ok} correct · ❌ ${bad} erreur(s) · 💡 ${hint} indice(s)`
    + (fixed ? ` · 🔁 ${fixed} corrigé(s) après reprise` : '')
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
  rec.listening = true;
  rec.lastProgress = Date.now();
  $('#btn-mic').classList.add('on');
  startRecognizer();
  // après 5 s sans progression, le mot attendu apparaît en gris
  rec.timer = setInterval(() => {
    const p = rec.shown.pos;
    if (!rec.pausing && p < rec.words.length && !rec.peeked.has(p) && Date.now() - rec.lastProgress > 5000) {
      rec.peeked.add(p);
      render();
    }
  }, 500);
}

function startRecognizer() {
  const r = new SR();
  r.lang = 'ar-SA';
  // Écoute continue : chaque redémarrage du micro fait un bip sur Android et perd
  // les mots prononcés pendant ce temps. On ne relance que si le navigateur coupe.
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 3;
  // les événements d'un micro déjà remplacé (après une reprise) sont ignorés
  r.onresult = (e) => { if (rec.recognition === r) onResult(e); };
  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      $('#heard').textContent = 'Accès au micro refusé.';
      stopListening();
    }
  };
  r.onend = () => {
    if (rec.recognition !== r) return;
    rec.committed = rec.shown; // garde le dernier résultat provisoire si aucun final n'est arrivé
    newSession();
    if (checkReplay(rec.committed)) return;
    if (rec.committed.pos >= rec.words.length) { render(); finish(); return; }
    if (rec.listening) { try { r.start(); } catch { stopListening(); } }
  };
  newSession();
  rec.recognition = r;
  try { r.start(); } catch { stopListening(); }
}

function stopListening() {
  rec.listening = false;
  rec.pausing = false;
  if (sayAudio) sayAudio.pause();
  clearInterval(rec.timer);
  if (rec.shown) rec.committed = rec.shown;
  if (rec.recognition) { try { rec.recognition.abort(); } catch { /* déjà arrêté */ } rec.recognition = null; }
  $('#btn-mic').classList.remove('on');
}

$('#btn-mic').addEventListener('click', () => {
  if (rec.listening) { stopListening(); return; }
  unlockSayAudio();
  startListening();
});
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

$('#opt-replay').checked = rec.replay;
$('#opt-replay').addEventListener('change', () => {
  rec.replay = $('#opt-replay').checked;
  store.set('replay', rec.replay);
});

$('#severity').value = rec.level;
$('#severity').addEventListener('change', () => {
  rec.level = Number($('#severity').value);
  store.set('level', rec.level);
});

// ---------- Démarrage ----------
loadData();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js');
}
