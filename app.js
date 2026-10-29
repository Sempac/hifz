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
//   insMin   longueur minimale d'un mot en trop pour le signaler (0 = pas de détection)
const LEVELS = {
  1: { tol: 0.25, extra: 2, unsure: 0, shortOk: false, insMin: 2 },
  2: { tol: 0.34, extra: 2, unsure: 0, shortOk: false, insMin: 2 },
  3: { tol: 0.42, extra: 3, unsure: 1, shortOk: false, insMin: 3 },
  4: { tol: 0.5, extra: 3, unsure: 1, shortOk: true, insMin: 3 },
  5: { tol: 0.58, extra: 4, unsure: 2, shortOk: true, insMin: 0 },
};

// Deux mots sont considérés identiques s'ils diffèrent d'au plus une part des lettres
// (la reconnaissance vocale n'est pas parfaite). Les mots très courts doivent être exacts.
function same(a, b) {
  if (a === b) return true;
  // l'article « ال » commun ne doit pas compter dans la ressemblance (الدنيا ≠ الرحيم)
  if (a.startsWith('ال') && b.startsWith('ال') && a.length > 3 && b.length > 3) { a = a.slice(2); b = b.slice(2); }
  if (Math.min(a.length, b.length) <= 2) return false;
  // la part tolérée se compte aussi sur le plus court : « وَالْيَوْمِ » n'est pas « وَلَوْ »
  // (3 lettres de différence sur 6, mais « ولو » n'en a que 3) ; sauf mot coupé par le modèle
  // (« وَأَنْ » + « تُمْ » pour « وَأَنْتُمْ ») : le début du mot est alors entendu tel quel
  const d = lev(a, b), tol = LEVELS[rec.level].tol;
  const cut = a.startsWith(b) || b.startsWith(a);
  return d / Math.max(a.length, b.length) <= tol && (cut || d <= Math.max(1, Math.floor(Math.min(a.length, b.length) * tol)));
}

// Liaison (wasl) : un mot qui commence par l'alif de liaison (اللَّهِ, الْأَرْضِ, اسْتَغْفِرُوا…) perd
// cet alif quand on ne s'arrête pas avant lui : « مِنَ اللَّهِ » se dit « minallāhi » et la
// reconnaissance écrit « مِنَلَّهِ » ou « مِنَ لَّهِ ». Devant une lettre solaire, le ل de l'article
// disparaît aussi (« مِنَ الشُّهَدَاءِ » → « مِنَشُّهَدَاءِ »), et une voyelle longue finale du mot
// d'avant s'abrège (« فِي الْأَرْضِ » → « فِلْأَرْضِ »).
const squeeze = (s) => s.replace(/(.)\1+/g, '$1'); // lettre doublée (shadda) : une seule
const waslForms = (n) => (n.startsWith('ال') ? [n.slice(1), n.slice(2)] : [n.slice(1)]).map(squeeze);

// le mot attendu E[p], entendu sans son alif de liaison
function waslAlone(w, p) {
  const e = rec.words[p];
  if (!e.wasl) return false;
  // mot court (« لَّهِ ») : identique, au ā long près (« لَّاهُ »)
  const sw = squeeze(w), noA = (s) => s.replace(/ا/g, '');
  return waslForms(e.norm).some((f) => (f.length <= 2 ? noA(sw) === noA(f) : same(sw, f)));
}

// Écritures de E[p] devant un mot à alif de liaison : telle quelle, voyelle longue finale abrégée,
// ou tanwin dont le ن prend une kasra (التقاء الساكنين : « أَحَدٌ ۝ اللَّهُ » enchaînés se disent
// « aḥaduni-llāhu », « نُوحٌ ابْنَهُ » → « nūḥuni-bnah »).
function beforeWasl(p) {
  const e = rec.words[p], a = e.norm;
  const forms = [a, a.replace(/[اوي]$/, '')];
  if (/[ًٌٍ]/.test(e.text)) forms.push(a.replace(/[اي]$/, '') + 'ن');
  return forms;
}

// E[p] entendu seul avec le ن du tanwin (« أَحَدُنِ » pour « أَحَدٌ » devant « اللَّهُ »)
function tanwinNunAlone(w, p) {
  const E = rec.words;
  return p + 1 < E.length && E[p + 1].wasl && /[ًٌٍ]/.test(E[p].text) && squeeze(w) === squeeze(beforeWasl(p)[2]);
}

// les mots attendus E[p] et E[p + 1] entendus collés par la liaison
function waslJoined(w, p) {
  const E = rec.words;
  if (p + 1 >= E.length || !E[p + 1].wasl) return false;
  const sw = squeeze(w);
  return beforeWasl(p).some((x) => waslForms(E[p + 1].norm).some((f) => same(sw, squeeze(x + f))));
}

// النون الساكنة والتنوين devant le mot suivant : le ن s'assimile à sa première lettre (الإدغام,
// devant ي ن م و ل ر : « مِنْ رَبِّهِمْ » → « مِرَّبِّهِمْ », « هُدًى لِلْمُتَّقِينَ » → « هُدَلِّلْمُتَّقِينَ »)
// ou devient م (الإقلاب, devant ب : « مِنْ بَعْدِ » → « مِمْبَعْدِ », « سَمِيعٌ بَصِيرٌ » → « سَمِيعُمْ بَصِيرٌ »).
// Renvoie les écritures possibles de E[p] ainsi prononcé (vide si la règle ne s'applique pas).
function nunForms(p) {
  const E = rec.words, e = E[p], nx = E[p + 1];
  if (!nx) return []; // (en fin de verset, la règle vaut si l'on enchaîne avec le suivant)
  const t = e.text.normalize('NFC'), first = nx.norm[0];
  const nun = /نْ?$/.test(t), tanwin = /[ًٌٍ]/.test(t);
  if (!(nun || tanwin)) return [];
  const added = first === 'ب' ? 'م' : 'ينمولر'.includes(first) ? first : null;
  const base = nun ? e.norm.slice(0, -1) : e.norm;
  // tanwin : l'alif ou le ى qui le porte ne se prononce pas (« هُدًى » → « هُدَ »)
  const bases = tanwin ? [base, base.replace(/[اي]$/, '')] : [base];
  // الإظهار والإخفاء : le tanwin s'entend « n » quand on enchaîne, et la reconnaissance l'écrit
  // (« صِرٌّ أَصَابَتْ » → « صِرُّنْ ») ; sans ن, c'est l'arrêt (sukun) ou une simple variante
  if (!added) return tanwin ? bases.map((b) => b + 'ن').filter((f) => f !== e.norm) : [];
  return bases.flatMap((b) => [b, b + added]).filter((f) => f.length >= 1 && f !== e.norm);
}

// E[p] entendu seul, assimilé (« مِ » ou « مِرْ » pour « مِنْ » devant « رَبِّهِمْ »)
const nunAlone = (w, p) => nunForms(p).includes(squeeze(w));

// E[p] et E[p + 1] entendus collés par l'assimilation (« مِرَّبِّهِمْ »)
function nunJoined(w, p) {
  const sw = squeeze(w), b = rec.words[p + 1]?.norm;
  return nunForms(p).some((x) => same(sw, squeeze(x + b)));
}

// Ce que la reconnaissance comprend pour un mot donné chez cet utilisateur,
// appris quand il touche un mot marqué faux à tort : { motAttendu: [motsEntendus] }
const learned = store.get('learned', {});
const isLearned = (heard, expected) => !!learned[expected]?.includes(heard);

// ---------- Données ----------
let QURAN = [];
// Sélection en cours : un titre et la liste des versets (elle peut couvrir plusieurs sourates)
let current = null; // { title, ayahs: [{ s, a }] }
const ayahKey = (x) => `${x.s}:${x.a}`;
const ayahText = (x) => QURAN[x.s - 1].a[x.a - 1];
// Tous les mots du Coran (normalisés), construits au premier besoin
let quranVocab = null;
const isQuranWord = (w) => (quranVocab ||= new Set(QURAN.flatMap((s) => s.a.flatMap((a) => a.split(/\s+/).map(norm))))).has(w);

// Position de chaque mot dans l'audio mot par mot de Quran.com, pour les versets
// où son découpage diffère du nôtre : { "sourate:verset": [positions] }
let WBW = {};

async function loadData() {
  const res = await fetch('data/quran.json');
  QURAN = await res.json();
  renderList();
  refreshPageInfo();
  refreshHizbInfo();
  renderReview();
  renderFavs();
  WBW = await fetch('data/wbw.json').then((r) => r.json()).catch(() => ({}));
}

function wordAudioUrl(w) {
  const pos = WBW[`${w.s}:${w.ayah}`]?.[w.k] ?? w.k + 1;
  return `https://audio.qurancdn.com/wbw/${pad3(w.s)}_${pad3(w.ayah)}_${pad3(pos)}.mp3`;
}

// Tous les versets du Coran dans l'ordre, avec leur page (mushaf de Médine) et leur quart de hizb.
let ALL = null;
function allAyahs() {
  if (!ALL) ALL = QURAN.flatMap((s) => s.a.map((_, i) => ({ s: s.n, a: i + 1, p: s.p[i], q: s.q[i] })));
  return ALL;
}

// Titre d'affichage d'un en-tête de sourate dans le texte
function surahHead(s) {
  const div = document.createElement('div');
  div.className = 'surah-head';
  div.textContent = `سورة ${QURAN[s - 1].name}`;
  return div;
}

// ---------- Navigation ----------
const views = { home: $('#view-home'), learn: $('#view-learn'), recite: $('#view-recite'), labo: $('#view-labo') };

function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  if (name !== 'learn') { stopAudio(); stopRecording(); }
  if (name === 'home' && window.closeMushaf) closeMushaf();
  if (name !== 'recite') { stopListening(); $('#lens').hidden = true; }
  if (name !== 'labo' && window.stopLabo) window.stopLabo();
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
let pickerSurah = null;

function openPicker(s) {
  const saved = store.get('range-' + s.n, null);
  const total = s.a.length;
  $('#picker-title').textContent = `${s.n}. ${s.en} — ${s.name}`;
  $('#from').max = $('#to').max = total;
  $('#from').value = saved ? saved[0] : 1;
  $('#to').value = saved ? saved[1] : Math.min(total, total <= 20 ? total : 10);
  pickerSurah = s;
  $('#picker').hidden = false;
}

function readRange() {
  const s = pickerSurah, total = s.a.length;
  let from = Math.max(1, Math.min(total, parseInt($('#from').value, 10) || 1));
  let to = Math.max(1, Math.min(total, parseInt($('#to').value, 10) || total));
  if (to < from) [from, to] = [to, from];
  store.set('range-' + s.n, [from, to]);
  $('#picker').hidden = true;
  const ayahs = [];
  for (let a = from; a <= to; a++) ayahs.push({ s: s.n, a });
  current = { title: `${s.en} ${from}–${to}`, ayahs };
}

const rangeTitle = () => current.title;

// ---------- Choix par pages ou par hizb ----------
const clampInt = (v, min, max, def) => Math.max(min, Math.min(max, parseInt(v, 10) || def));

function pagesSelection() {
  let p1 = clampInt($('#page-from').value, 1, 604, 1);
  let p2 = clampInt($('#page-to').value, 1, 604, p1);
  if (p2 < p1) [p1, p2] = [p2, p1];
  return { title: p1 === p2 ? `Page ${p1}` : `Pages ${p1}–${p2}`, ayahs: allAyahs().filter((x) => x.p >= p1 && x.p <= p2) };
}

const QUART = ['', '1er quart', '2e quart', '3e quart', '4e quart'];
function hizbSelection() {
  const h = clampInt($('#hizb-num').value, 1, 60, 1);
  const part = +$('#hizb-part').value; // 0 = hizb entier, 1-4 = un quart
  const q1 = (h - 1) * 4 + (part || 1), q2 = part ? q1 : h * 4;
  return { title: `Hizb ${h}` + (part ? ` · ${QUART[part]}` : ''), ayahs: allAyahs().filter((x) => x.q >= q1 && x.q <= q2) };
}

// Résumé d'une sélection : du premier au dernier verset
function selectionInfo(sel) {
  if (!sel.ayahs.length) return '';
  const f = sel.ayahs[0], l = sel.ayahs[sel.ayahs.length - 1];
  const name = (x) => `${QURAN[x.s - 1].en} ${x.a}`;
  return `De ${name(f)} à ${name(l)} · ${sel.ayahs.length} versets`;
}

function refreshPageInfo() {
  store.set('pages', [$('#page-from').value, $('#page-to').value]);
  $('#page-info').textContent = QURAN.length ? selectionInfo(pagesSelection()) : '';
}
function refreshHizbInfo() {
  store.set('hizb', [$('#hizb-num').value, $('#hizb-part').value]);
  $('#hizb-info').textContent = QURAN.length ? selectionInfo(hizbSelection()) : '';
}

for (let h = 1; h <= 60; h++) $('#hizb-num').add(new Option(`Hizb ${h} (juz ${Math.ceil(h / 2)})`, h));
[$('#page-from').value, $('#page-to').value] = store.get('pages', ['1', '2']);
[$('#hizb-num').value, $('#hizb-part').value] = store.get('hizb', ['1', '0']);
['#page-from', '#page-to'].forEach((id) => $(id).addEventListener('input', refreshPageInfo));
['#hizb-num', '#hizb-part'].forEach((id) => $(id).addEventListener('change', refreshHizbInfo));

$('#page-learn').addEventListener('click', () => { current = pagesSelection(); openLearn(); });
$('#page-recite').addEventListener('click', () => { current = pagesSelection(); openRecite(); });
$('#hizb-learn').addEventListener('click', () => { current = hizbSelection(); openLearn(); });
$('#hizb-recite').addEventListener('click', () => { current = hizbSelection(); openRecite(); });

// Onglets de l'accueil : Sourates / Pages / Hizb
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== 'panel-' + name; });
  store.set('tab', name);
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
showTab(store.get('tab', 'surah'));

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

// La sélection couvre-t-elle plusieurs sourates ? (on affiche alors le nom de chaque sourate)
const multiSurah = () => current.ayahs.some((x) => x.s !== current.ayahs[0].s);

function openLearn() {
  $('#learn-title').textContent = rangeTitle();
  $('#learn-msg').hidden = true;
  const box = $('#learn-text');
  box.innerHTML = '';
  const multi = multiSurah();
  let prevS = 0;
  for (const x of current.ayahs) {
    if (multi && x.s !== prevS) box.appendChild(surahHead(x.s));
    prevS = x.s;
    const span = document.createElement('span');
    span.className = 'ayah';
    span.dataset.k = ayahKey(x);
    span.innerHTML = `${ayahText(x)} <span class="mark">﴿${arNum(x.a)}﴾</span> `;
    span.addEventListener('click', () => play([x]));
    box.appendChild(span);
  }
  go('learn');
  applyLearnView();
}

// ---------- Affichage en pages du mushaf (Apprendre) ----------
let learnView = store.get('learnView', 'page'); // 'page' (mushaf) ou 'text' (texte continu)

// Pages couvertes par la sélection (le dernier verset peut se terminer sur la page suivante)
async function selectionPages() {
  const f = current.ayahs[0], l = current.ayahs[current.ayahs.length - 1];
  const first = QURAN[f.s - 1].p[f.a - 1];
  let last = QURAN[l.s - 1].p[l.a - 1];
  const d = await mushafPageData(last);
  if (!d.w.some((w) => w[2] === l.s && w[3] === l.a && w[4] === 0) && last < 604) last++;
  return [first, last];
}

const nextFrame = () => new Promise((r) => setTimeout(r, 30));

async function applyLearnView(startPage) {
  const paged = learnView === 'page';
  $('#btn-view').textContent = paged ? '≡ Affichage texte' : '📖 Affichage livre';
  $('#learn-text').hidden = paged;
  $('#learn-book').hidden = !paged;
  const f = current.ayahs[0];
  if (!paged) { closeMushaf(); updateFrame('learn', QURAN[f.s - 1].p[f.a - 1]); return; }
  const host = $('#learn-book');
  const keys = new Set(current.ayahs.map(ayahKey));
  const [first, last] = await selectionPages();
  await document.fonts.ready; // le cadre a sa taille définitive
  await nextFrame();
  mushaf.onFlip = (n) => updateFrame('learn', n);
  await openMushaf(host, first, last, (s, a) => keys.has(`${s}:${a}`), startPage || first);
  updateFrame('learn', mushafCurrentPage());
}

// Téléphone tourné (portrait ↔ paysage) : le livre est reconstruit à la nouvelle taille, sur la même page
let resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!views.learn.hidden && learnView === 'page' && mushaf.flip) applyLearnView(mushafCurrentPage());
    if (!views.recite.hidden && rec.book) applyReciteView(mushafCurrentPage());
  }, 300);
});

// Surligne un verset dans le livre (lecture, enregistrement) et tourne jusqu'à sa page
function markBookAyah(key, cls) {
  document.querySelectorAll(`.mw.${cls}`).forEach((el) => el.classList.remove(cls));
  if (!key || learnView !== 'page') return;
  document.querySelectorAll(`.mbook .mw[data-k="${key}"]`).forEach((el) => el.classList.add(cls));
  const p = mushafPageOf(`.mw[data-k="${key}"]`);
  if (p) mushafGoto(p);
}

$('#btn-view').addEventListener('click', () => {
  learnView = learnView === 'page' ? 'text' : 'page';
  store.set('learnView', learnView);
  stopAudio();
  $('#learn-settings').hidden = true;
  applyLearnView();
});

// Toucher un mot du livre : écouter son verset
$('#learn-book').addEventListener('click', (e) => {
  const w = e.target.closest('.mw');
  if (!w || w.classList.contains('out')) return;
  const x = current.ayahs.find((y) => ayahKey(y) === w.dataset.k);
  if (x) play([x]);
});

function play(ayahs) {
  const rep = parseInt($('#repeat').value, 10);
  playlist = ayahs.flatMap((x) => Array(rep).fill(x));
  playIdx = 0;
  playNext();
}

async function playNext() {
  document.querySelectorAll('.ayah.playing').forEach((el) => el.classList.remove('playing'));
  if (playIdx >= playlist.length) { stopAudio(); return; }
  const x = playlist[playIdx];
  const reciter = $('#reciter').value;
  if (reciter === 'me') {
    const saved = await idbGet(ayahKey(x));
    if (!playlist.length) return; // arrêté pendant la lecture de la base
    if (!saved) {
      showLearnMsg(`Verset ${QURAN[x.s - 1].en} ${x.a} pas encore enregistré avec votre voix.`);
      while (playIdx < playlist.length && playlist[playIdx] === x) playIdx++;
      playNext();
      return;
    }
    if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
    audio.src = URL.createObjectURL(new Blob([saved.buf], { type: saved.type }));
  } else {
    audio.src = `https://everyayah.com/data/${reciter}/${pad3(x.s)}${pad3(x.a)}.mp3`;
  }
  audio.play().catch(() => stopAudio());
  const el = document.querySelector(`.ayah[data-k="${ayahKey(x)}"]`);
  if (el && learnView === 'text') { el.classList.add('playing'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  markBookAyah(ayahKey(x), 'playing');
  $('#btn-play').textContent = '⏸';
}

function stopAudio() {
  audio.pause();
  playlist = [];
  document.querySelectorAll('.ayah.playing, .mw.playing').forEach((el) => el.classList.remove('playing'));
  $('#btn-play').textContent = '▶';
}

audio.addEventListener('ended', () => { playIdx++; playNext(); });
$('#btn-play').addEventListener('click', () => {
  if (playlist.length) { stopAudio(); return; }
  play(current.ayahs);
});

function showLearnMsg(text) {
  $('#learn-msg').textContent = text;
  $('#learn-msg').hidden = false;
}

// ---------- Enregistrement de sa propre récitation (stocké dans le téléphone) ----------
const dbReady = new Promise((resolve, reject) => {
  try {
    // rec : dernière récitation de chaque verset (« Ma récitation ») ;
    // train : ancien écran « Entraîner sur ma voix » (retiré, magasin gardé pour ne pas changer la version)
    const req = indexedDB.open('hifz', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('rec')) db.createObjectStore('rec');
      if (!db.objectStoreNames.contains('train')) db.createObjectStore('train', { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  } catch (e) { reject(e); }
});

async function idb(mode, fn, name = 'rec') {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const req = fn(tx.objectStore(name));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const idbGet = (key) => idb('readonly', (s) => s.get(key)).catch(() => undefined);
const idbPut = (key, val) => idb('readwrite', (s) => s.put(val, key));

const recording = { stream: null, recorder: null, i: 0 }; // i : rang du verset dans la sélection

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
  recordAyah(0);
}

function recordAyah(i) {
  document.querySelectorAll('.ayah.recording').forEach((el) => el.classList.remove('recording'));
  recording.i = i;
  const x = current.ayahs[i];
  const key = ayahKey(x);
  const el = document.querySelector(`.ayah[data-k="${key}"]`);
  if (el && learnView === 'text') { el.classList.add('recording'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  markBookAyah(key, 'recording');
  $('#rec-label').textContent = `⏺ ${QURAN[x.s - 1].en} ${x.a} : récitez puis touchez Suivant`;
  $('#rec-next').textContent = i >= current.ayahs.length - 1 ? 'Terminer ✔' : 'Suivant ▶';

  const r = new MediaRecorder(recording.stream);
  const chunks = [];
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
  document.querySelectorAll('.ayah.recording, .mw.recording').forEach((el) => el.classList.remove('recording'));
  $('#rec-bar').hidden = true;
  $('#btn-record').disabled = false;
}

$('#btn-record').addEventListener('click', startRecording);
$('#rec-stop').addEventListener('click', stopRecording);
$('#rec-next').addEventListener('click', () => {
  if (recording.recorder) { recording.recorder.stop(); recording.recorder = null; }
  if (recording.i >= current.ayahs.length - 1) {
    stopRecording();
    $('#reciter').value = 'me';
    store.set('reciter', 'me');
    showLearnMsg('Récitation enregistrée. « Ma récitation » est sélectionnée : touchez ▶ Écouter.');
  } else {
    recordAyah(recording.i + 1);
  }
});

// ---------- Écran 3 : réciter ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const rec = {
  words: [],        // { text, norm } pour chaque mot attendu
  spans: [],
  level: store.get('level', store.get('severity', 'soft') === 'strict' ? 2 : 4),
  overrides: new Set(), // mots marqués justes à la main par l'utilisateur
  forcedBad: new Set(), // mots marqués faux à la main (appui long)
  counted: new Set(),   // mots déjà pris en compte par l'apprentissage automatique
  flagged: new Set(),   // mots signalés comme fautes (✗) pendant cette récitation
  reviewOut: null,      // mots sortis de « À revoir » à la fin de cette récitation (null : pas encore compté)
  replay: store.get('replay', true), // reprise sur erreur
  beeps: store.get('beeps', 1),      // bips (on reprend seul) avant le rappel prononcé
  waqf: store.get('waqf', 'rec'),    // signes d'arrêt (WAQF_SHOWN)
  // écoute par phrase (au lieu de continue) : par défaut sur iPhone / iPad, où Safari suit mieux ainsi
  phrase: store.get('phrase', /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)),
  lastEventAt: 0,       // dernière nouvelle de la reconnaissance (chien de garde iPhone / iPad)
  lensZoom: Number(store.get('lensZoom', 1.6)), // loupe sur la ligne en cours (0 = désactivée)
  engine: store.get('engine', 'device'),   // reconnaissance : 'device' (Google / Apple) ou 'server' (serveur Hifz)
  serverUrl: store.get('serverUrl', ''),   // adresse WebSocket du serveur Hifz
  lensTarget: null,     // mot attendu dans le livre (suivi par la loupe)
  showDelay: store.get('showDelay', false), // afficher l'attente entre deux réponses du micro
  lastResultAt: 0,      // heure de la dernière réponse du micro
  noReplay: new Set(),  // erreurs vues dans une réponse en retard : marquées, sans rappel
  retries: {},          // mot → nombre de reprises
  firstErr: {},         // mot → nature de l'erreur à la première reprise (bilan)
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
// grace   : tolérance juste après un (re)démarrage du micro (bip sur Android) :
//           le début de la reprise peut être coupé ou mal compris
// graceSkip : pendant cette tolérance, des mots manquants sont acceptés (pas après un rappel,
//             où le mot à retrouver doit vraiment être dit)
// ins       : mots en trop, par position du mot attendu devant lequel ils ont été ajoutés
// vow       : mots reconnus mais avec une voyelle fausse (serveur Hifz) : ce qui a été entendu
const newState = () => ({ pos: 0, marks: [], extra: 0, pending: [], heard: {}, ins: {}, vow: {}, grace: 0, graceSkip: true });
const clone = (st) => ({ pos: st.pos, marks: st.marks.slice(), extra: st.extra, pending: st.pending.slice(), heard: { ...st.heard }, ins: { ...st.ins }, vow: { ...st.vow }, grace: st.grace, graceSkip: st.graceSkip });
const GRACE_WORDS = 2;

// ---------- Signes d'arrêt (comme le cheikh qui fait signe de s'arrêter) ----------
// Signes de waqf du mushaf (mot qui les précède). Le signe s'affiche dès l'avant-dernier mot
// avant l'arrêt (la position n'est connue qu'avec un peu de retard). C'est une invitation :
// continuer n'est jamais compté comme une erreur. Réglage rec.waqf :
// off = aucun, end = fins de verset, rec = + ۘ (obligatoire) et ۗ (préférable), all = + ۚ (permis).
// Jamais sur ۖ (continuer préférable), ۙ (ne pas s'arrêter), ۛ (l'un des deux) ni ۜ (سكتة).
const WAQF_MARKS = { 'ۘ': 'lazim', 'ۗ': 'qila', 'ۚ': 'jaiz', 'ۖ': 'sila', 'ۙ': 'la', 'ۛ': 'muanaqa', 'ۜ': 'sakta' };
const WAQF_SHOWN = { off: [], end: ['end'], rec: ['end', 'lazim', 'qila'], all: ['end', 'lazim', 'qila', 'jaiz'] };
const WAQF_LABEL = { end: '⏸ Fin du verset', lazim: '⏸ ۘ Arrêt obligatoire', qila: '⏸ ۗ Arrêt préférable', jaiz: '⏸ ۚ Arrêt permis' };
function waqfAhead(pos) {
  const kinds = WAQF_SHOWN[rec.waqf] || [];
  for (const j of [pos, pos + 1]) if (j < rec.words.length - 1 && kinds.includes(rec.words[j].stop)) return j;
  return -1;
}
function showWaqf(j) {
  const el = $('#waqf-sign');
  el.hidden = j < 0;
  if (j >= 0) el.textContent = WAQF_LABEL[rec.words[j].stop];
}

function openRecite() {
  $('#recite-title').textContent = rangeTitle();
  const box = $('#recite-text');
  box.innerHTML = '';
  rec.words = [];
  rec.spans = [];
  const multi = multiSurah();
  let prevS = 0;
  for (const x of current.ayahs) {
    if (multi && x.s !== prevS) box.appendChild(surahHead(x.s));
    prevS = x.s;
    const n = x.a;
    let k = 0;
    for (const t of ayahText(x).split(/\s+/)) {
      const nw = norm(t);
      if (!nw) { // signes isolés (ex. ۞) ; un signe de waqf s'applique au mot qui le précède
        const prev = rec.words[rec.words.length - 1];
        if (WAQF_MARKS[t] && prev && prev.s === x.s && prev.ayah === n) prev.stop = WAQF_MARKS[t];
        continue;
      }
      const span = document.createElement('span');
      span.className = 'w';
      span.textContent = t;
      const idx = rec.words.length;
      span.dataset.i = idx;
      box.appendChild(span);
      box.appendChild(document.createTextNode(' '));
      // wasl : commence par l'alif de liaison (pas أ / إ / آ), sauf le tout premier mot récité
      rec.words.push({ text: t, norm: nw, s: x.s, ayah: n, k: k++, wasl: idx > 0 && /^[اٱ]/.test(t.normalize('NFC')) });
      rec.spans.push(span);
    }
    const last = rec.words[rec.words.length - 1];
    if (last && last.ayah === n && last.stop !== 'sakta') last.stop = 'end'; // fin de verset (sauf سكتة, 18:1 et 69:28)
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = `﴿${arNum(n)}﴾`;
    box.appendChild(mark);
    box.appendChild(document.createTextNode(' '));
  }
  $('#no-speech').hidden = recognitionAvailable();
  $('#btn-mic').disabled = !recognitionAvailable();
  rec.textSpans = rec.spans;
  rec.book = false;
  resetRecite();
  go('recite');
  rec.placeFab();
  applyReciteView();
}

// ---------- Réciter sur les pages du mushaf ----------
// Chaque mot attendu est relié au mot dessiné dans le livre (un mot du livre peut regrouper
// deux mots du texte, ex. « يَٰٓأَيُّهَا »). Les mots restent cachés à leur place sur la page.
async function applyReciteView(startPage) {
  const paged = learnView === 'page';
  views.recite.classList.toggle('book', paged);
  $('#btn-recite-view').textContent = paged ? '≡ Affichage texte' : '📖 Affichage livre';
  $('#recite-text').hidden = paged;
  $('#recite-book').hidden = !paged;
  rec.book = false;
  rec.spans = rec.textSpans;
  if (!paged) { closeMushaf(); $('#lens').hidden = true; render(); return; } // le cadre suit le mot attendu (render)
  const keys = new Set(current.ayahs.map(ayahKey));
  const [first, last] = await selectionPages();
  await document.fonts.ready;
  await nextFrame();
  const w0 = rec.words[Math.min(rec.shown.pos, rec.words.length - 1)];
  mushaf.onFlip = (n) => { updateFrame('recite', n); setTimeout(() => updateLens(rec.lensTarget), 60); };
  await openMushaf($('#recite-book'), first, last, (s, a) => keys.has(`${s}:${a}`), startPage || QURAN[w0.s - 1].p[w0.ayah - 1]);
  rec.glyph = rec.words.map((w) => {
    const pos = WBW[`${w.s}:${w.ayah}`]?.[w.k] ?? w.k + 1;
    return document.querySelector(`.mbook .mw[data-w="${w.s}:${w.ayah}:${pos}"]`);
  });
  rec.glyphWords = new Map();
  rec.glyph.forEach((g, i) => { if (g) { if (!rec.glyphWords.has(g)) rec.glyphWords.set(g, []); rec.glyphWords.get(g).push(i); } });
  rec.spans = rec.glyph; // le rappel surligne les mots récités dans le livre
  rec.book = true;
  render();
  updateFrame('recite', mushafCurrentPage());
}

const MARK_RANK = { ok: 1, hint: 2, fixed: 3, unsure: 4, bad: 5 };

// Affichage dans le livre : un mot du livre prend la pire marque de ses mots du texte ;
// le livre tourne tout seul jusqu'à la page du mot attendu.
function renderBook(st, waqf = -1) {
  let target = null;
  rec.glyphWords.forEach((idxs, g) => {
    let cls = 'mw';
    if (idxs.every((i) => i < st.pos)) {
      let worst = 'ok';
      for (const i of idxs) { const m = markOf(st, i); if (MARK_RANK[m] > MARK_RANK[worst]) worst = m; }
      cls += ' ' + worst + (idxs.some((i) => rec.flagged.has(i)) ? ' flag' : '');
    } else if (idxs.includes(st.pos)) {
      cls += rec.peeked.has(st.pos) ? ' peek current' : ' hidden current';
      target = g;
    } else cls += ' hidden';
    if (idxs.includes(waqf)) cls += ' waqf';
    g.className = cls;
  });
  rec.lensTarget = st.pos < rec.words.length ? target : null;
  if (!target && st.pos >= rec.words.length) target = rec.glyph[rec.words.length - 1];
  const p = target ? Number(target.closest('.mpage').dataset.page) : 0;
  if (p && p !== mushafCurrentPage()) { mushafGoto(p); $('#lens').hidden = true; } // la loupe revient une fois la page tournée
  else updateLens(rec.lensTarget);
}

// ---------- Loupe ----------
// Bandeau agrandi posé sur la ligne en cours : la ligne précédente, la ligne en cours et la
// suivante (2 lignes seulement en haut et en bas de page). En largeur, la ligne occupe
// exactement la largeur de l'écran (comme sans les marges) ; le réglage agrandit la hauteur.
function updateLens(target) {
  const lens = $('#lens');
  const z = rec.lensZoom;
  if (!rec.book || !z || !target || views.recite.hidden || !$('#summary').hidden) { lens.hidden = true; return; }
  const line = target.closest('.mline');
  const lr = line.getBoundingClientRect();
  if (!lr.height) { // page pas encore affichée (ouverture, page qui tourne) : on réessaie
    lens.hidden = true;
    clearTimeout(rec.lensRetry);
    rec.lensRetry = setTimeout(() => { if (rec.lensTarget === target) updateLens(target); }, 200);
    return;
  }
  const body = line.parentElement;
  const rows = [line.previousElementSibling, line, line.nextElementSibling].filter(Boolean);
  const cs = getComputedStyle(body);
  const contentW = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const f = parseFloat(body.style.fontSize) || 20;
  const inner = lens.firstElementChild;
  inner.innerHTML = '';
  inner.style.fontSize = f + 'px';
  inner.style.width = contentW + 'px';
  for (const r of rows) { const c = r.cloneNode(true); c.style.width = contentW + 'px'; inner.appendChild(c); }
  lens.hidden = false;
  // largeur : la ligne remplit l'écran (petite marge) ; hauteur : agrandissement choisi
  const lensW = lens.clientWidth;
  const sx = (lensW - 12) / contentW;
  const sy = Math.max(sx, z);
  const lensH = rows.length * f * 1.6 * sy + 8;
  lens.style.height = lensH + 'px';
  inner.style.transform = `translateX(6px) scale(${sx}, ${sy})`;
  // vertical : centré sur la ligne en cours, dans les limites du cadre
  const vr = views.recite.getBoundingClientRect();
  const top = Math.max(vr.top + 46, Math.min(lr.top + lr.height / 2 - lensH / 2, vr.bottom - 42 - lensH));
  lens.style.top = top + 'px';
}

$('#lens-zoom').value = String(rec.lensZoom);
$('#lens-zoom').addEventListener('change', () => {
  rec.lensZoom = Number($('#lens-zoom').value);
  store.set('lensZoom', rec.lensZoom);
  updateLens(rec.lensTarget);
});

$('#btn-recite-view').addEventListener('click', () => {
  learnView = learnView === 'page' ? 'text' : 'page';
  store.set('learnView', learnView);
  $('#settings').hidden = true;
  applyReciteView();
});

// ---------- Panneaux de réglages (⚙ en haut à droite du cadre) ----------
$('#btn-settings').addEventListener('click', () => {
  $('#mic-log').textContent = [
    `Appareil : ${IOS ? 'iPhone / iPad' : 'autre'} · écoute ${rec.phrase ? 'par phrase' : 'continue'} · niveau ${rec.level}`,
    navigator.userAgent, '', ...micLines,
  ].join('\n') || '(vide)';
  $('#settings').hidden = false;
});
$('#learn-gear').addEventListener('click', () => { $('#learn-settings').hidden = false; });
document.querySelectorAll('.sheet').forEach((sh) => {
  sh.addEventListener('click', (e) => { if (e.target === sh || e.target.closest('.sheet-close')) sh.hidden = true; });
});
// Recommencer et Indice sont dans les réglages : le panneau se ferme pour voir la page
['#btn-restart', '#btn-hint'].forEach((id) => $(id).addEventListener('click', () => { $('#settings').hidden = true; }));
$('#btn-record').addEventListener('click', () => { $('#learn-settings').hidden = true; });

// ---------- Cadre : sourate, juz et numéro de la page affichée ----------
const JUZ = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر',
  'الحادي عشر', 'الثاني عشر', 'الثالث عشر', 'الرابع عشر', 'الخامس عشر', 'السادس عشر', 'السابع عشر', 'الثامن عشر',
  'التاسع عشر', 'العشرون', 'الحادي والعشرون', 'الثاني والعشرون', 'الثالث والعشرون', 'الرابع والعشرون',
  'الخامس والعشرون', 'السادس والعشرون', 'السابع والعشرون', 'الثامن والعشرون', 'التاسع والعشرون', 'الثلاثون'];
const framePage = { learn: 0, recite: 0 };

async function updateFrame(name, page) {
  if (!page) return;
  framePage[name] = page;
  const view = views[name];
  const d = await mushafPageData(page);
  const w = d.w.find((x) => x[4] > 0) || d.w[0]; // premier mot de la page
  const s = w[2], a = w[3];
  view.querySelector('.c-surah').textContent = `سورة ${QURAN[s - 1].name}`;
  view.querySelector('.c-juz').textContent = `الجزء ${JUZ[Math.ceil(QURAN[s - 1].q[a - 1] / 8) - 1]}`;
  view.querySelector('.c-page').textContent = arNum(page);
  const fav = view.querySelector('.fav-btn');
  fav.textContent = favs[page] ? '★' : '☆';
  fav.classList.toggle('on', !!favs[page]);
}

// ---------- Favoris : pages marquées d'une étoile ----------
const favs = store.get('favs', {}); // { page: date d'ajout }
document.querySelectorAll('.fav-btn').forEach((b) => b.addEventListener('click', () => {
  const name = b.closest('#view-learn') ? 'learn' : 'recite';
  const p = framePage[name];
  if (!p) return;
  if (favs[p]) delete favs[p]; else favs[p] = Date.now();
  store.set('favs', favs);
  updateFrame(name, p);
  renderFavs();
}));

const pageSelection = (p) => ({ title: `Page ${p}`, ayahs: allAyahs().filter((x) => x.p === p) });

function renderFavs() {
  const ul = $('#fav-list');
  ul.innerHTML = '';
  const pages = Object.keys(favs).map(Number).sort((x, y) => x - y);
  if (!pages.length) { ul.innerHTML = '<li><span class="rinfo">Aucune page favorite.</span></li>'; return; }
  for (const p of pages) {
    const first = allAyahs().find((x) => x.p === p);
    const li = document.createElement('li');
    li.innerHTML = `<span class="rw">★</span><span class="rinfo">Page ${p}${first ? ` · ${QURAN[first.s - 1].en} ${first.a}` : ''}</span>`
      + '<button aria-label="Apprendre">📖</button><button aria-label="Réciter">🎤</button><button aria-label="Retirer">✕</button>';
    const [bl, br, bx] = li.querySelectorAll('button');
    bl.addEventListener('click', () => { current = pageSelection(p); openLearn(); });
    br.addEventListener('click', () => { current = pageSelection(p); openRecite(); });
    bx.addEventListener('click', () => { delete favs[p]; store.set('favs', favs); renderFavs(); });
    ul.appendChild(li);
  }
}

// ---------- Appui long sur un mot déjà récité : vert ↔ rouge ----------
// Le micro ne détecte pas tout (voyelle fausse, mot proche…) : l'utilisateur corrige lui-même.
// Appui long (et non simple toucher) pour éviter les erreurs de manipulation en tournant les pages.
const LONG_PRESS_MS = 500;

// Indices des mots du texte sous le doigt (un mot du livre peut en regrouper deux)
function wordsAt(target) {
  const g = target.closest('.mw');
  if (g) return rec.glyphWords?.get(g) || [];
  const w = target.closest('#recite-text .w');
  return w ? [Number(w.dataset.i)] : [];
}

function toggleWords(idxs) {
  idxs = idxs.filter((i) => i < rec.shown.pos); // seulement les mots déjà récités
  if (!idxs.length) return;
  const isBad = (i) => ['bad', 'unsure'].includes(markOf(rec.shown, i));
  if (idxs.some(isBad)) idxs.forEach(markRight); else idxs.forEach(markWrong);
  render();
  if (!$('#summary').hidden) finish(); // met à jour le bilan
}

// « C'était une faute » : rouge, dans « À revoir », et l'application oublie ce qu'elle avait
// appris pour ce mot (elle l'avait peut-être accepté à cause de cet apprentissage)
function markWrong(i) {
  const w = rec.words[i];
  rec.overrides.delete(i);
  rec.forcedBad.add(i);
  if (learned[w.norm]) { delete learned[w.norm]; store.set('learned', learned); }
  if (learnCounts[w.norm]) { delete learnCounts[w.norm]; store.set('learnCounts', learnCounts); }
  rec.flagged.add(i);
  review[wordKey(w)] = { s: w.s, a: w.ayah, k: w.k, text: w.text, ok: 0 };
  saveReview();
  $('#heard').textContent = `🔴 « ${w.text} » marqué faux, ajouté à « À revoir ».`;
}

// « Je l'avais bien dit » : vert (comme ✓) ; retiré d'« À revoir » s'il y a été mis pendant cette récitation
function markRight(i) {
  const w = rec.words[i];
  if (rec.flagged.has(i)) { rec.flagged.delete(i); delete review[wordKey(w)]; saveReview(); }
  // marqué faux à la main puis remis : il retrouve sa couleur ; s'il était faux pour le micro, on le valide
  const wasForced = rec.forcedBad.delete(i);
  if (!wasForced || ['bad', 'unsure'].includes(markOf(rec.shown, i))) acceptWord(i);
  $('#heard').textContent = `🟢 « ${w.text} » validé.`;
}

['#recite-book', '#recite-text'].forEach((id) => {
  const host = $(id);
  let timer = null, start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  host.addEventListener('pointerdown', (e) => {
    const idxs = wordsAt(e.target);
    if (!idxs.length) return;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      timer = null;
      if (navigator.vibrate) navigator.vibrate(30);
      toggleWords(idxs);
    }, LONG_PRESS_MS);
  });
  host.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); // c'est un glissement (page)
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => host.addEventListener(t, cancel));
  host.addEventListener('contextmenu', (e) => e.preventDefault()); // pas de menu du navigateur à l'appui long
});

function resetRecite() {
  stopListening();
  rec.committed = newState();
  rec.shown = rec.committed;
  newSession();
  rec.peeked.clear();
  rec.overrides.clear();
  rec.forcedBad.clear();
  rec.counted.clear();
  rec.flagged.clear();
  rec.reviewOut = null;
  rec.retries = {};
  rec.firstErr = {};
  rec.lastReplayAt = -1;
  rec.noReplay.clear();
  $('#summary').hidden = true;
  $('#heard').textContent = '';
  $('#fix').hidden = true;
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
  st.grace = 0;
}

// Mots sautés : juste après un bip, 1 ou 2 mots manquants sont des mots coupés
// par le redémarrage du micro, acceptés sans erreur.
function skipped(st, p, count) {
  if (st.pending.length) resync(st, p, count); // des mots entendus en attente peuvent être parmi eux
  else if (st.grace > 0 && st.graceSkip && count <= GRACE_WORDS) for (let j = p; j < p + count; j++) markOk(st, j);
  else markSkipped(st, p, count);
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

// Cherche jusqu'à ANCHOR_MAX mots plus loin deux mots attendus consécutifs qui correspondent
// aux deux mots entendus w1 w2 (assez longs pour ne pas se tromper d'endroit).
const ANCHOR_MAX = 10;
function findAnchor(p, w1, w2) {
  const E = rec.words;
  for (let k = 1; k <= ANCHOR_MAX && p + k + 1 < E.length; k++) {
    const a = E[p + k].norm, b = E[p + k + 1].norm;
    if (a.length + b.length >= 5 && same(w1, a) && same(w2, b)) return k;
  }
  return 0;
}

// Mots p … p+k-1 rattrapés : chacun est juste s'il fait partie des mots entendus en attente
// (dans l'ordre), sinon il est marqué oublié. Le mot bloqué garde ce qui a été entendu à sa
// place, pour l'apprentissage.
function resync(st, p, k) {
  const pend = st.pending;
  let q = 0, firstFound = -1;
  const missing = [];
  for (let j = p; j < p + k; j++) {
    let found = -1;
    for (let t = q; t < pend.length; t++) if (same(pend[t], rec.words[j].norm)) { found = t; break; }
    if (found >= 0) { markOk(st, j); q = found + 1; if (firstFound < 0) firstFound = found; }
    else missing.push(j);
  }
  // ce qui a été entendu à la place du mot bloqué : les mots en attente avant le premier mot retrouvé
  const instead = pend.slice(0, firstFound >= 0 ? firstFound : pend.length).slice(0, 2);
  const L = LEVELS[rec.level];
  for (const j of missing) {
    if (j === p && instead.length) { st.marks[j] = 'bad'; st.heard[j] = instead; }
    else st.marks[j] = missing.length > L.unsure ? 'bad' : 'unsure';
  }
}

// Voyelles (serveur Hifz) : un mot reconnu lettre pour lettre mais dont une voyelle diffère
// est compté faux. La voyelle finale n'est pas exigée quand elle n'est pas prononcée
// (arrêt, waqf : sukun ou rien), mais une autre voyelle finale (ex. اللَّهِ pour اللَّهُ) est une erreur.
function vowelError(expected, heardRaw, stop = false) {
  return !!vowelDiff(expected, heardRaw, stop);
}

// Première voyelle fausse, pour l'expliquer : { letter, exp, got } (null si tout va bien)
const VOWEL_NAME = { a: 'فَتْحَة ـَ', u: 'ضَمَّة ـُ', i: 'كَسْرَة ـِ', an: 'تنوين فتح ـً', un: 'تنوين ضم ـٌ', in: 'تنوين كسر ـٍ' };
// (chaque morceau arabe isolé, U+2068 … U+2069, pour qu'il ne mette pas la phrase française dans le désordre)
const bidi = (t) => `⁨${t}⁩`;
const vowelName = (v) => bidi(VOWEL_NAME[v] || v);
function vowelExplain(expected, heardRaw) {
  const d = vowelDiff(expected, heardRaw, true) || vowelDiff(expected, heardRaw, false);
  return d ? `lettre « ${bidi(d.letter)} » : ${vowelName(d.got)} au lieu de ${vowelName(d.exp)}` : '';
}

function vowelDiff(expected, heardRaw, stop = false) {
  if (!heardRaw || !/[ً-ِ]/.test(heardRaw)) return null; // texte sans voyelles
  const a = laboSlots(expected), b = laboSlots(heardRaw);
  const pair = alignSlots(a, b);
  // dernière voyelle du mot (dans « تَأْثِيمًا », celle du م : le ا final n'en porte pas)
  let last = a.length - 1;
  while (last > 0 && !a[last].v) last--;
  for (let k = 0; k < a.length; k++) {
    if (!a[k].v || pair[k] === undefined) continue;
    const hv = b[pair[k]].v;
    // signe absent (« الْأُمورُ ») : le modèle ne l'a pas écrit, ce n'est pas une autre voyelle
    if (!hv) continue;
    if (k === last) {
      // arrêt (fin de verset, ou pause en plein verset) : la voyelle finale n'est pas prononcée
      // et ce que le modèle écrit à sa place n'a pas de sens (« الْحَكِيمِ » pour « الْحَكِيمُ »)
      if (!hv || stop) continue;
      // tanwin présent ou absent : arrêt, ou mot coupé entre deux morceaux (le modèle hésite
      // alors sur le « n »). Une autre voyelle (ٌ pour ٍ) reste une faute.
      if (hv.replace('n', '') === a[k].v.replace('n', '')) continue;
    }
    if (hv !== a[k].v) return { letter: [...a[k].raw][0], exp: a[k].v, got: hv };
  }
  return null;
}

function checkVowels(st, j, heardRaw, pause = false) {
  if (!vowelCheck() || st.marks[j] === 'bad') return;
  const E = rec.words, endOfAyah = j + 1 >= E.length || E[j + 1].ayah !== E[j].ayah || E[j + 1].s !== E[j].s;
  if (vowelError(E[j].text, heardRaw, endOfAyah || pause)) { st.marks[j] = 'bad'; st.vow[j] = heardRaw; }
}

// Fait avancer l'état avec les mots entendus (raw : les mêmes, tels qu'écrits, avec voyelles).
// stops : indices des mots entendus suivis d'une pause (voyelle finale non exigée).
function align(st, heard, raw = [], stops = new Set()) {
  const E = rec.words, N = E.length;
  for (let i = 0; i < heard.length && st.pos < N; i++) {
    const w = heard[i];
    const p = st.pos;
    // lettre isolée (bruit, fin du son d'un rappel) : ignorée, sauf si c'est le mot attendu (ق، ص، ن)
    // (ou « مِنْ » assimilé : « م » devant « رَبِّهِمْ »)
    if (w.length <= 1 && E[p].norm.length > 1 && !nunAlone(w, p)) continue;
    if (w === E[p].norm) { advanceOk(st, p); checkVowels(st, p, raw[i], stops.has(i)); continue; }
    if (isLearned(w, E[p].norm)) { advanceOk(st, p); continue; }
    // un mot exact un peu plus loin passe avant un mot seulement ressemblant ici
    // (ex. « لم يولد » ne doit pas valider « يلد »)
    let exact = 0;
    for (let k = 1; k <= 3 && p + k < N; k++) {
      if (E[p + k].norm.length >= 3 && w === E[p + k].norm) { exact = k; break; }
    }
    if (exact) { skipped(st, p, exact); advanceOk(st, p + exact); checkVowels(st, p + exact, raw[i], stops.has(i)); continue; }
    // deux mots attendus entendus collés (« أَيْنَمَا » pour « أَيْنَ مَا ») : avant la simple
    // ressemblance, sinon « أينما » passerait pour « أين » et « ما » pour un oubli
    const both = p + 1 < N ? E[p].norm + E[p + 1].norm : null;
    if (both && same(w, both) && lev(w, both) < lev(w, E[p].norm)) { markOk(st, p); advanceOk(st, p + 1); continue; }
    if (same(w, E[p].norm)) { advanceOk(st, p); continue; }
    // liaison : « مِنَ اللَّهِ » entendu « مِنَلَّهِ », ou « اللَّهِ » entendu « لَّهِ »
    if (waslJoined(w, p)) { markOk(st, p); advanceOk(st, p + 1); continue; }
    if (waslAlone(w, p)) { advanceOk(st, p); continue; }
    if (tanwinNunAlone(w, p)) { advanceOk(st, p); continue; }
    // إدغام / إقلاب : « مِنْ رَبِّهِمْ » entendu « مِرَّبِّهِمْ », ou « مِنْ » entendu « مِ »
    if (nunJoined(w, p)) { markOk(st, p); advanceOk(st, p + 1); continue; }
    if (nunAlone(w, p)) { advanceOk(st, p); continue; }
    // voyelle longue abrégée avant la liaison : « وَمَا » entendu « وَمَ » devant « اللَّهُ »
    if (p + 1 < N && E[p + 1].wasl && E[p].norm.length > 2 && w === E[p].norm.replace(/[اوي]$/, '')) { advanceOk(st, p); continue; }
    // un mot attendu entendu en deux morceaux (pas si le second morceau est à lui seul le mot
    // attendu : le premier est alors un mot en trop)
    if (i + 1 < heard.length && !same(heard[i + 1], E[p].norm) && same(w + heard[i + 1], E[p].norm)) {
      advanceOk(st, p); i++; continue;
    }
    // mot(s) sauté(s) : le mot entendu correspond à un mot un peu plus loin
    let skip = 0;
    for (let k = 1; k <= 3 && p + k < N; k++) {
      if (E[p + k].norm.length >= 3 && same(w, E[p + k].norm)) { skip = k; break; }
    }
    if (skip) { skipped(st, p, skip); advanceOk(st, p + skip); continue; }
    // l'utilisateur répète des mots déjà récités (par exemple il reprend le verset) : on les ignore
    let repeated = false;
    for (let j = Math.max(0, p - 12); j < p; j++) if (same(w, E[j].norm)) { repeated = true; break; }
    if (repeated) continue;
    // l'utilisateur a avancé alors que l'application attendait encore un mot : on le retrouve
    // plus loin grâce à 2 mots de suite, puis les mots intermédiaires sont vérifiés un par un
    const anchor = i + 1 < heard.length ? findAnchor(p, w, heard[i + 1]) : 0;
    if (anchor) { resync(st, p, anchor); advanceOk(st, p + anchor); advanceOk(st, p + anchor + 1); i++; continue; }
    // juste après un bip, un mot mal compris (coupé) est ignoré, mais pas un vrai mot du Coran
    // (3 lettres ou plus) : il peut être en trop (« بِاللَّهِ وَالْيَوْمَ الْآخِرَ وَلَوْ » repris après le bip)
    if (st.grace > 0) { st.grace--; if (w.length < 3 || !isQuranWord(w)) continue; }
    // mot en trop : un mot hors du texte suivi du bon mot attendu. Traité comme un oubli :
    // le mot attendu passe en rouge (et le rappel fait reprendre à cet endroit)
    const insMin = LEVELS[rec.level].insMin;
    // un bout de mot coupé en deux (fin du mot précédent, ex. « الْآخِي » + « رِينَ ») n'est pas un mot en trop
    // (mais « إِبْرَاهِيمَ » déjà entier + « مُصَلًّى » ajouté n'en est pas un : le recoller doit rapprocher du mot)
    const tail = i > 0 && p > 0 && same(heard[i - 1] + w, E[p - 1].norm)
      && lev(heard[i - 1] + w, E[p - 1].norm) < lev(heard[i - 1], E[p - 1].norm);
    // (plusieurs mots en trop d'affilée aussi : « بِاللَّهِ وَالْيَوْمِ الْآخِرِ وَلَوْ » pour « بِاللَّهِ وَلَوْ »,
    // s'ils sont tous de vrais mots et non des bouts de bruit)
    // un morceau d'un seul mot hors du Coran (« كبح » entre deux versets) est du bruit
    const noise = stops.has(i) && (i === 0 || stops.has(i - 1)) && !isQuranWord(w);
    const before = st.pending.every((x) => x.length >= insMin) ? st.pending : null;
    if (insMin && !tail && !noise && w.length >= insMin && before && before.length + 1 < LEVELS[rec.level].extra && i + 1 < heard.length) {
      const nx = heard[i + 1];
      if (nx === E[p].norm || isLearned(nx, E[p].norm) || same(nx, E[p].norm)) {
        st.marks[p] = 'bad';
        st.ins[p] = [...before, w].join(' ');
        st.pos = p + 1;
        st.extra = 0;
        st.pending = [];
        st.grace = 0;
        i++;
        continue;
      }
    }
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
  if (rec.forcedBad.delete(i)) { render(); return; } // il avait été marqué faux à la main
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
  const waqf = $('#summary').hidden ? waqfAhead(st.pos) : -1;
  showWaqf(waqf);
  if (rec.book) renderBook(st, waqf);
  else {
    rec.spans.forEach((el, i) => {
      let cls = 'w';
      if (i < st.pos) cls += ' ' + markOf(st, i);
      else if (i === st.pos && rec.peeked.has(i)) cls += ' peek current';
      else cls += ' hidden' + (i === st.pos ? ' current' : '');
      if (i === waqf) cls += ' waqf';
      el.className = cls;
    });
    const cur = rec.spans[st.pos];
    if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
    rec.flagged.forEach((i) => rec.spans[i]?.classList.add('flag'));
    // le cadre indique la page (sourate, juz) du mot attendu
    const w = rec.words[Math.min(st.pos, rec.words.length - 1)];
    const p = w && QURAN[w.s - 1].p[w.ayah - 1];
    if (p && p !== framePage.recite) updateFrame('recite', p);
  }
  const t = validateTarget();
  // « off » plutôt que disabled : un bouton désactivé ne reçoit plus le doigt pour être déplacé
  $('#fab-word').textContent = t >= 0 ? rec.words[t].text : '';
  $('#btn-validate').classList.toggle('off', t < 0);
  const f = flagTarget();
  $('#flag-word').textContent = f >= 0 ? rec.words[f].text : '';
  $('#btn-flag').classList.toggle('off', f < 0);
}

// ---------- « À revoir » : les fautes signalées par l'utilisateur ----------
// Gardées dans le téléphone : { "sourate:verset:mot": { s, a, k, text, ok } }
// ok = récitations justes de suite depuis le signalement ; à REVIEW_OK, le mot sort de la liste.
const REVIEW_OK = 3;
const review = store.get('review', {});
const wordKey = (w) => `${w.s}:${w.ayah}:${w.k}`;
const saveReview = () => { store.set('review', review); renderReview(); };

// Mot que ✗ signale : celui du rappel en cours, sinon le dernier mot avec un souci
// (faux, non entendu, corrigé après rappel, indice), sinon le mot attendu si l'application
// est bloquée dessus, sinon le dernier mot récité.
function flagTarget() {
  const st = rec.shown;
  if (!st) return -1;
  const N = rec.words.length;
  if (rec.pausing && st.pos < N) return st.pos;
  for (let i = st.pos - 1; i >= Math.max(0, st.pos - REPLAY_WINDOW); i--) {
    if (markOf(st, i) !== 'ok' && !rec.flagged.has(i)) return i;
  }
  if (st.pos < N && st.pending.length) return st.pos;
  return st.pos > 0 ? st.pos - 1 : -1;
}

function flagWord() {
  const i = flagTarget();
  if (i < 0) return;
  rec.flagged.add(i);
  const w = rec.words[i];
  review[wordKey(w)] = { s: w.s, a: w.ayah, k: w.k, text: w.text, ok: 0 };
  saveReview();
  $('#heard').textContent = `🚩 « ${w.text} » ajouté à « À revoir ».`;
  render();
}

// En fin de récitation : progrès des mots à revoir qui étaient dans le passage.
function updateReview() {
  let out = 0;
  rec.words.forEach((w, i) => {
    const r = review[wordKey(w)];
    if (!r || rec.flagged.has(i)) return;
    if (markOf(rec.shown, i) === 'ok' && !rec.overrides.has(i)) {
      r.ok++;
      if (r.ok >= REVIEW_OK) { delete review[wordKey(w)]; out++; }
    } else r.ok = 0; // erreur, indice ou rappel : on recommence à compter
  });
  saveReview();
  return out;
}

// Versets contenant des mots à revoir, dans l'ordre du mushaf
function reviewAyahs(entries) {
  const seen = new Set(), ayahs = [];
  entries.sort((x, y) => x.s - y.s || x.a - y.a || x.k - y.k);
  for (const r of entries) { const k = `${r.s}:${r.a}`; if (!seen.has(k)) { seen.add(k); ayahs.push({ s: r.s, a: r.a }); } }
  return ayahs;
}

function renderReview() {
  const entries = Object.entries(review).map(([key, r]) => ({ key, ...r }));
  $('#review-count').textContent = entries.length ? `(${entries.length})` : '';
  const ul = $('#review-list');
  ul.innerHTML = '';
  $('#review-actions').hidden = !entries.length;
  if (!entries.length) { ul.innerHTML = '<li><span class="rinfo">Aucun mot à revoir.</span></li>'; return; }
  for (const r of entries.sort((x, y) => x.s - y.s || x.a - y.a || x.k - y.k)) {
    const li = document.createElement('li');
    const name = QURAN.length ? QURAN[r.s - 1].en : `Sourate ${r.s}`;
    li.innerHTML = `<span class="rw" dir="rtl"></span><span class="rinfo">${name} ${r.a} · ${r.ok}/${REVIEW_OK} juste</span><button aria-label="Retirer">✕</button>`;
    li.querySelector('.rw').textContent = r.text;
    li.querySelector('button').addEventListener('click', () => { delete review[r.key]; saveReview(); });
    ul.appendChild(li);
  }
}

const reviewSelection = () => ({ title: 'À revoir', ayahs: reviewAyahs(Object.values(review)) });
$('#review-learn').addEventListener('click', () => { current = reviewSelection(); openLearn(); });
$('#review-recite').addEventListener('click', () => { current = reviewSelection(); openRecite(); });

// ---------- Bouton flottant « Valider » ----------
// Valide d'un pouce, sans chercher le mot dans la page : le mot attendu si l'application
// est bloquée dessus, sinon le dernier mot rouge ou gris récent, sinon le mot attendu.
function validateTarget() {
  const st = rec.shown;
  if (!st) return -1;
  const N = rec.words.length;
  if (st.pos < N && st.pending.length) return st.pos;
  for (let i = st.pos - 1; i >= Math.max(0, st.pos - REPLAY_WINDOW); i--) {
    const m = markOf(st, i);
    if (m === 'bad' || m === 'unsure') return i;
  }
  return st.pos < N ? st.pos : -1;
}

function validate() {
  const t = validateTarget();
  if (t < 0) return;
  if (t < rec.shown.pos) { acceptWord(t); return; }
  // mot attendu : il devient juste, ce qui a été entendu à sa place est retenu
  const st = clone(rec.shown);
  const exp = rec.words[t].norm;
  const heard = st.pending.filter((h) => h !== exp).slice(0, 2);
  if (heard.length) {
    learned[exp] = [...new Set([...(learned[exp] || []), ...heard])];
    store.set('learned', learned);
    $('#heard').textContent = `Retenu : « ${heard.join(' ')} » sera accepté pour « ${rec.words[t].text} ».`;
  }
  st.marks[t] = 'ok';
  st.pos = t + 1;
  st.extra = 0;
  st.pending = [];
  st.grace = 0;
  // la session continue : les mots déjà entendus sont considérés comme traités
  rec.base = clone(st);
  rec.offset = rec.heardCount;
  setShown(st, true);
}

// Les deux boutons se déplacent ensemble au doigt ; un simple toucher agit. La position est retenue.
(function setupFab() {
  const fab = $('#fab-group');
  const place = (x, y) => {
    x = Math.max(4, Math.min(innerWidth - fab.offsetWidth - 4, x));
    y = Math.max(4, Math.min(innerHeight - fab.offsetHeight - 4, y));
    Object.assign(fab.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
  };
  let start = null, moved = false;
  fab.addEventListener('pointerdown', (e) => {
    const r = fab.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, btn: e.target.closest('button') };
    moved = false;
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener('pointermove', (e) => {
    if (!start) return;
    if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 8) return;
    moved = true;
    place(e.clientX - start.dx, e.clientY - start.dy);
  });
  fab.addEventListener('pointerup', () => {
    if (!start) return;
    const btn = start.btn;
    start = null;
    if (moved) {
      const r = fab.getBoundingClientRect();
      store.set('fabPos', [r.left / innerWidth, r.top / innerHeight]);
    } else if (btn && !btn.classList.contains('off')) {
      if (btn.id === 'btn-validate') validate(); else flagWord();
    }
  });
  // position retenue (en proportion de l'écran), appliquée quand l'écran Réciter s'affiche
  rec.placeFab = () => {
    const p = store.get('fabPos', null);
    if (p) place(p[0] * innerWidth, p[1] * innerHeight);
  };
})();

// ---------- Apprentissage automatique ----------
// Quand un mot est compté faux alors que les mots juste avant et juste après sont justes,
// ce que la reconnaissance a écrit à sa place est noté. Si la même chose revient
// AUTO_LEARN fois pour ce mot (sur plusieurs récitations), elle est acceptée ensuite.
const AUTO_LEARN = 2;
const learnCounts = store.get('learnCounts', {}); // { motAttendu: { motEntendu: nombre } }

function autoLearn(st) {
  const newly = [];
  for (const k of Object.keys(st.heard)) {
    const i = Number(k);
    if (rec.counted.has(i) || i + 1 >= st.pos || markOf(st, i) !== 'bad') continue;
    if (markOf(st, i + 1) !== 'ok' || (i > 0 && markOf(st, i - 1) !== 'ok')) continue;
    rec.counted.add(i); // une seule fois par récitation pour ce mot
    const exp = rec.words[i].norm;
    for (const h of st.heard[i]) {
      if (h === exp || isLearned(h, exp)) continue;
      const c = (learnCounts[exp] ||= {});
      c[h] = (c[h] || 0) + 1;
      if (c[h] >= AUTO_LEARN) {
        learned[exp] = [...(learned[exp] || []), h];
        newly.push(`« ${h} » pour « ${rec.words[i].text} »`);
      }
    }
  }
  store.set('learnCounts', learnCounts);
  if (newly.length) {
    store.set('learned', learned);
    $('#heard').textContent = `Appris : ${newly.join(', ')} sera accepté la prochaine fois.`;
  }
}

function setShown(st, commit) {
  if (st.pos !== rec.shown.pos) rec.lastProgress = Date.now();
  rec.shown = st;
  if (commit) { rec.committed = st; autoLearn(st); }
  // le rappel passe avant la fin : une erreur sur le dernier mot doit aussi être reprise
  if (checkReplay(st, commit)) return;
  render();
  if (commit && st.pos >= rec.words.length) finish();
}

// ---------- Reprise sur erreur ----------
// Sur une erreur, le micro se coupe et l'utilisateur reprend au mot faux. Les rec.beeps premières
// fois, un simple bip (il cherche seul) ; ensuite l'application annonce « الكلمة تُنطق هكذا » et fait
// entendre le mot récité (audio mot par mot). Après cela, le mot reste rouge sans nouvelle
// interruption (repriseMax).
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

// Bip court (0,15 s, 880 Hz) fabriqué une fois, joué par le même lecteur que les rappels (iPhone).
const BEEP = (() => {
  const rate = 16000, n = rate * 0.15, buf = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, s) => [...s].forEach((c, k) => buf.setUint8(o + k, c.charCodeAt(0)));
  str(0, 'RIFF'); buf.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true); buf.setUint16(22, 1, true); buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  str(36, 'data'); buf.setUint32(40, n * 2, true);
  for (let k = 0; k < n; k++) {
    const fade = Math.min(1, k / 160, (n - k) / 160); // sans clic au début ni à la fin
    buf.setInt16(44 + k * 2, Math.sin(2 * Math.PI * 880 * k / rate) * 9000 * fade, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
})();

function playBeep(done) {
  sayAudio = sayEl;
  sayEl.onended = sayEl.onerror = () => { sayAudio = null; done(); };
  sayEl.src = BEEP;
  sayEl.play().catch(() => { sayAudio = null; done(); });
}

// « الكلمة تُنطق هكذا » : enregistrement phrase.mp3, joué par le même lecteur que les rappels
// (iPhone). S'il manque, voix de synthèse du téléphone (sayPhraseTts).
function sayPhrase(text, done) {
  sayPhrase.info = 'voix : phrase.mp3';
  sayAudio = sayEl;
  let over = false;
  const end = () => { if (!over) { over = true; sayAudio = null; done(); } };
  const fail = () => { if (!over) { over = true; sayAudio = null; sayPhraseTts(text, done); micLog(sayPhrase.info); } };
  sayEl.onended = end;
  sayEl.onerror = fail;
  sayEl.src = 'phrase.mp3';
  sayEl.play().catch(fail);
}

// Voix de synthèse du téléphone, en arabe : la voix arabe si elle est listée,
// sinon on demande l'arabe au moteur (Android en télécharge une au besoin). S'il ne répond pas,
// on passe à la suite. sayPhrase.info : ce qui s'est passé (journal du micro).
function sayPhraseTts(text, done) {
  const tts = window.speechSynthesis;
  if (!tts) { sayPhrase.info = 'voix : synthèse vocale absente'; done(); return; }
  const voice = tts.getVoices().find((v) => v.lang.toLowerCase().startsWith('ar'));
  sayPhrase.info = 'voix : ' + (voice ? voice.name : 'aucune voix arabe listée (' + tts.getVoices().length + ' voix)');
  let over = false;
  const end = () => { if (!over) { over = true; done(); } };
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'ar-SA';
  u.onend = end;
  u.onerror = (e) => { micLog('voix : erreur ' + e.error); end(); };
  setTimeout(end, 4000);
  tts.cancel();
  tts.speak(u);
}
window.speechSynthesis?.getVoices(); // Chrome charge la liste des voix au premier appel

// Récite les mots un par un (audio mot par mot), en les surlignant.
function sayWords(idxs, done) {
  const urls = idxs.map((j) => wordAudioUrl(rec.words[j]));
  // préchargement pour réduire les blancs entre les mots
  urls.forEach((u) => { const a = new Audio(); a.preload = 'auto'; a.src = u; });
  let n = 0;
  const next = () => {
    document.querySelectorAll('.w.say').forEach((el) => el.classList.remove('say'));
    if (!rec.pausing || n >= urls.length) { sayAudio = null; done(); return; }
    rec.spans[idxs[n]]?.classList.add('say');
    sayAudio = sayEl;
    sayEl.onended = next;
    sayEl.onerror = next;
    sayEl.src = urls[n++];
    sayEl.play().catch(next);
  };
  next();
}

// Un mot faux ou « non entendu » (souvent un oubli) déclenche le rappel, seulement s'il est
// récent (parmi les REPLAY_WINDOW derniers mots) : on ne fait jamais revenir loin en arrière.
// Sur iPhone, les résultats restent longtemps provisoires : on n'attend pas le résultat
// définitif si l'erreur est déjà suivie de REPLAY_CONFIRM mots justes.
const REPLAY_WINDOW = 6;
const REPLAY_CONFIRM = 2;

// Après un rappel, pas de nouveau rappel avant REPLAY_SETTLE mots justes : le temps de se remettre
// dans la récitation (les erreurs restent marquées, sans interrompre).
const REPLAY_SETTLE = 3;

// interruptions au plus pour un même mot : les bips puis la prononciation (2 fois s'il n'y a pas de bip)
const repriseMax = () => Math.max(2, rec.beeps + 1);

function checkReplay(st, final) {
  if (!rec.replay || !rec.listening || rec.pausing) return false;
  if (rec.lastReplayAt >= 0 && st.pos < rec.lastReplayAt + REPLAY_SETTLE) return false;
  for (let i = Math.max(0, st.pos - REPLAY_WINDOW); i < st.pos; i++) {
    const m = markOf(st, i);
    if ((m !== 'bad' && m !== 'unsure') || (rec.retries[i] || 0) >= repriseMax() || rec.noReplay.has(i)) continue;
    if (!final && st.pos - 1 - i < REPLAY_CONFIRM) continue; // provisoire : pas encore assez sûr
    replayAt(i);
    return true;
  }
  return false;
}

function replayAt(i) {
  rec.lastReplayAt = i;
  rec.pausing = true;
  rec.retries[i] = (rec.retries[i] || 0) + 1;
  rec.firstErr[i] ||= errorKind(rec.shown, i); // pour le bilan, même si le mot est retrouvé ensuite
  const r = rec.recognition;
  rec.recognition = null;
  if (r) { try { r.abort(); } catch { /* déjà arrêté */ } }

  const st = clone(rec.shown);
  st.pos = i;
  st.marks.length = i;
  st.extra = 0;
  st.pending = [];
  for (const k of Object.keys(st.heard)) if (Number(k) >= i) delete st.heard[k];
  const extraWord = st.ins[i]; // rappel dû à un mot en trop ?
  const vowelWord = st.vow[i]; // … ou à une voyelle fausse ?
  for (const k of Object.keys(st.ins)) if (Number(k) >= i) delete st.ins[k];
  for (const k of Object.keys(st.vow)) if (Number(k) >= i) delete st.vow[k];
  rec.shown = rec.committed = st;
  newSession();
  render();

  const resume = () => {
    if (!rec.pausing) return;
    rec.pausing = false;
    if (rec.listening) {
      rec.lastProgress = Date.now();
      startRecognizer();
      rec.base.graceSkip = false;
    }
  };
  // serveur : micro rouvert un peu après la fin du son (sinon il capte la fin du son du
  // haut-parleur, que le serveur transforme en lettres isolées comptées comme des fautes)
  const after = () => setTimeout(resume, rec.engine === 'server' ? 400 : 0);
  const word = rec.words[i].text;
  // explication détaillée dans l'encadré (la ligne du bas est remplacée par les mots entendus
  // dès la reprise) ; pour un oubli ou un autre mot, le mot attendu n'est montré qu'à la prononciation
  const vowelFix = vowelWord ? [['🔤 Voyelle : vous avez dit'], [vowelWord, 'bad'], ['au lieu de'], [word, 'ok'], [vowelExplain(word, vowelWord), '', true]] : null;
  if (rec.retries[i] <= rec.beeps) {
    micLog('bip au mot ' + (i + 1));
    $('#heard').textContent = extraWord ? '🔔 Mot en trop. Reprenez.' : vowelWord ? '🔔 Voyelle. Reprenez ce mot.' : '🔔 Erreur : reprenez à l\'endroit indiqué.';
    showFix(extraWord ? [['🔔 Mot en trop :'], [extraWord, 'bad'], ['Reprenez sans lui.']] : vowelFix || [['🔔 Erreur : reprenez à l\'endroit indiqué.']]);
    playBeep(after);
  } else {
    micLog('prononciation du mot ' + (i + 1));
    $('#heard').textContent = '🔊 الكلمة تُنطق هكذا';
    showFix(extraWord ? [['➕ Mot en trop :'], [extraWord, 'bad'], ['Le mot attendu :'], [word, 'ok']]
      : vowelFix || [['🔊 الكلمة تُنطق هكذا :'], [word, 'ok'], ['Écoutez, puis reprenez ce mot.']]);
    sayPhrase('الكلمة تُنطق هكذا', () => (rec.pausing ? sayWords([i], after) : null));
    micLog(sayPhrase.info);
  }
}

// Encadré d'explication d'une erreur, en haut de l'écran, en grand : morceaux [texte, mot arabe
// entendu (bad) ou attendu (ok), ligne à part ?].
// Il reste affiché pendant la reprise (15 s), et disparaît à l'erreur suivante ou en fin de récitation.
function showFix(parts) {
  const box = $('#fix');
  box.textContent = '';
  for (const [text, ar, line] of parts) {
    if (!text) continue;
    const el = document.createElement(line ? 'div' : 'span');
    el.textContent = text;
    if (ar) { el.className = 'ar ' + ar; el.dir = 'rtl'; el.lang = 'ar'; }
    box.append(el, ' ');
  }
  box.hidden = false;
  clearTimeout(showFix.timer);
  showFix.timer = setTimeout(() => { box.hidden = true; }, 15000);
}

const markOf = (st, i) => (rec.forcedBad.has(i) ? 'bad' : rec.overrides.has(i) ? 'ok' : st.marks[i] || 'ok');

// Nature d'une erreur sur le mot i : oubli (rien entendu à sa place), mot en trop avant lui,
// autre mot (entendu, sans ressemblance : erreur de mémoire), ou mal prononcé (voyelle fausse,
// ou mot entendu proche du bon, ex. « سِرٌّ » pour « صِرٌّ »).
function errorKind(st, i) {
  if (st.marks[i] === 'hint') return 'hint';
  if (st.ins[i]) return 'extra';
  if (st.vow[i]) return 'pron';
  const e = rec.words[i].norm, h = st.heard[i] || [];
  if (!h.length) return 'forgot';
  return h.some((x) => lev(x, e) / Math.max(x.length, e.length) <= 0.5) ? 'pron' : 'subst';
}

const KIND_LABEL = {
  forgot: 'oublié', subst: 'autre mot', extra: 'mot en trop avant', hint: 'indice', pron: 'mal prononcé',
};

function playWord(i) {
  sayEl.onended = sayEl.onerror = null;
  sayEl.src = wordAudioUrl(rec.words[i]);
  sayEl.play().catch(() => { /* hors ligne */ });
}

function finish() {
  $('#lens').hidden = true;
  stopListening();
  const marks = rec.words.map((_, i) => markOf(rec.shown, i));
  const ok = marks.filter((m) => m === 'ok').length;
  const unsure = marks.filter((m) => m === 'unsure').length;
  const pct = Math.round((ok / Math.max(1, rec.words.length - unsure)) * 100);
  // progrès des mots « À revoir » : une seule fois par récitation (finish peut être rappelé)
  if (rec.reviewOut === null) rec.reviewOut = updateReview();
  const flagged = [...rec.flagged].sort((x, y) => x - y).map((i) => rec.words[i]);

  // les mots à retravailler, par nature d'erreur : mémoire (oubli, autre mot, mot en trop,
  // indice), prononciation, et mots justes que le micro avait mal entendus (validés en les touchant)
  const memory = [], pron = [], misheard = [];
  rec.words.forEach((w, i) => {
    const m = marks[i];
    if (rec.overrides.has(i)) { misheard.push({ i }); return; }
    if (m === 'ok' || rec.forcedBad.has(i)) return; // marqué faux à la main : dans « À revoir »
    const fixed = m === 'fixed';
    const kind = fixed ? rec.firstErr[i] || 'forgot' : m === 'unsure' ? 'forgot' : errorKind(rec.shown, i);
    const heard = fixed ? '' : rec.shown.ins[i] || rec.shown.vow[i] || (kind !== 'forgot' && (rec.shown.heard[i] || []).join(' ')) || '';
    const why = !fixed && rec.shown.vow[i] ? vowelExplain(rec.words[i].text, rec.shown.vow[i]) : '';
    (kind === 'pron' ? pron : memory).push({ i, kind, fixed, heard, why });
  });
  const line = ({ i, kind, fixed, heard, why }) => {
    const w = rec.words[i];
    return `<div class="rl"><button class="say-w" data-i="${i}" aria-label="Écouter">🔊</button>`
      + `<span class="rw" dir="rtl">${w.text}</span> <small>${QURAN[w.s - 1].en} ${w.ayah}`
      + (kind ? ` · ${KIND_LABEL[kind]}` : '') + (heard ? ` (entendu « ${heard} »)` : '') + (why ? ` · ${why}` : '')
      + (fixed ? ' · retrouvé après le bip' : '') + '</small></div>';
  };
  const group = (title, list, help, id) => (list.length
    ? `<div class="rv"><b>${title} : ${list.length}</b><br><small>${help}</small>${list.map(line).join('')}`
      + (id ? `<button id="${id}" class="btn primary">🎤 Réciter à nouveau ces versets</button>` : '') + '</div>'
    : '');

  $('#summary').innerHTML = `<b>${pct} %</b><br>✅ ${ok} mot(s) juste(s) du premier coup`
    + (rec.reviewOut ? `<br>🎉 ${rec.reviewOut} mot(s) sorti(s) de « À revoir »` : '')
    + group('🧠 Mémoire', memory, 'Mots oubliés, remplacés ou ajoutés : réciter ces versets encore.', 'btn-redo-memory')
    + group('🗣 Prononciation', pron, 'Écoutez (🔊) puis répétez le mot.', 'btn-redo-pron')
    + group('🎙 Mal entendus par le micro', misheard, 'Vous les avez touchés pour les valider : ils comptent justes.')
    + (flagged.length
      ? `<div class="rv">🚩 À revoir : ${flagged.length} mot(s)<br>${flagged.map((w) => `<span class="rw" dir="rtl">${w.text}</span> <small>(${QURAN[w.s - 1].en} ${w.ayah})</small>`).join('<br>')}</div>`
        + '<button id="btn-review-these" class="btn primary">🎤 Réviser ces versets</button>'
      : '');
  $('#summary').hidden = false;
  $('#fix').hidden = true;
  $('#summary').querySelectorAll('.say-w').forEach((b) => b.addEventListener('click', () => playWord(+b.dataset.i)));
  const redo = (title, list) => {
    current = { title, ayahs: reviewAyahs(list.map(({ i }) => ({ s: rec.words[i].s, a: rec.words[i].ayah, k: rec.words[i].k }))) };
    openRecite();
  };
  $('#btn-redo-memory')?.addEventListener('click', () => redo('Mémoire', memory));
  $('#btn-redo-pron')?.addEventListener('click', () => redo('Prononciation', pron));
  $('#btn-review-these')?.addEventListener('click', () => redo('À revoir', flagged.map((w) => ({ i: rec.words.indexOf(w) }))));
}

// Texte entendu depuis le début de la session. Sur Android, un segment peut répéter
// le précédent en le complétant (« قل هو » puis « قل هو الله ») : on garde le plus long.
function sessionText(results, a) {
  // serveur Hifz : les morceaux sont toujours distincts, on les met bout à bout
  if (rec.engine === 'server') {
    const texts = results.map((r) => r[0].transcript.trim()).filter(Boolean);
    // dernier mot de chaque morceau : le serveur coupe aux pauses, donc à un arrêt (rec.segEnds :
    // indices des mots, la voyelle finale n'y est pas exigée)
    rec.segEnds = new Set();
    let n = 0;
    for (const t of texts) {
      n += t.split(/\s+/).filter((w) => norm(w)).length;
      rec.segEnds.add(n - 1);
    }
    return texts.join(' ');
  }
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
    const raw = text.split(/\s+/).filter((t) => norm(t)); // mots tels qu'entendus (avec voyelles si serveur)
    const heard = raw.map(norm);
    const stops = rec.engine === 'server' ? new Set([...rec.segEnds].map((k) => k - rec.offset)) : new Set();
    const st = align(clone(rec.base), heard.slice(rec.offset), raw.slice(rec.offset), stops);
    const sc = score(st);
    if (sc > bestScore) { best = st; bestScore = sc; bestText = text; bestCount = heard.length; }
  }
  // Réponse en retard (iPhone : la reconnaissance d'Apple envoie parfois les mots par paquets,
  // plusieurs secondes après) : les erreurs qu'elle révèle sont marquées, sans rappel, car
  // l'utilisateur est déjà plus loin dans sa récitation.
  const now = Date.now();
  const gap = now - rec.lastResultAt;
  const newWords = bestCount - rec.heardCount;
  if (newWords > 0) rec.lastResultAt = now;
  if (newWords >= LATE_WORDS || (gap > LATE_MS && newWords >= 3)) {
    for (let i = rec.shown.pos; i < best.pos; i++) {
      const m = best.marks[i];
      if (m === 'bad' || m === 'unsure') rec.noReplay.add(i);
    }
  }
  rec.heardCount = bestCount;
  const tail = bestText.split(/\s+/).slice(-8).join(' ');
  $('#heard').textContent = rec.showDelay && newWords > 0 ? `⏱ ${(gap / 1000).toFixed(1)} s · ${tail}` : tail;
  setShown(best, isFinal);
}
const LATE_WORDS = 5;   // mots arrivés d'un coup
const LATE_MS = 2500;   // attente depuis la réponse précédente

// Reconnaissance utilisable : celle du navigateur, ou le serveur Hifz (si une adresse est réglée)
const recognitionAvailable = () => (rec.engine === 'server' ? !!rec.serverUrl : !!SR);

// Le serveur Hifz renvoie le texte avec les voyelles : on les vérifie (sauf en Très souple)
const vowelCheck = () => rec.engine === 'server' && rec.level <= 4;

function startListening() {
  if (!recognitionAvailable() || rec.listening) return;
  if (rec.committed.pos >= rec.words.length) resetRecite();
  rec.listening = true;
  rec.lastProgress = Date.now();
  $('#btn-mic').classList.add('on');
  micT0 = Date.now();
  micLines.length = 0;
  micLog('micro lancé');
  startRecognizer();
  rec.timer = setInterval(() => {
    // après 5 s sans progression, le mot attendu apparaît en gris
    const p = rec.shown.pos;
    if (!rec.pausing && p < rec.words.length && !rec.peeked.has(p) && Date.now() - rec.lastProgress > 5000) {
      rec.peeked.add(p);
      render();
    }
    // iPhone / iPad : la reconnaissance de Safari cesse parfois d'envoyer des mots sans s'arrêter.
    // Sans aucune nouvelle d'elle pendant WATCHDOG_MS, on relance une écoute neuve.
    if (IOS && rec.engine !== 'server' && rec.recognition && !rec.pausing && Date.now() - rec.lastEventAt > WATCHDOG_MS) {
      micLog('relance (Safari muet depuis ' + Math.round((Date.now() - rec.lastEventAt) / 1000) + ' s)');
      const r = rec.recognition;
      rec.recognition = null;
      try { r.abort(); } catch { /* déjà arrêté */ }
      rec.committed = rec.shown;
      startRecognizer();
    }
  }, 500);
}

// iPhone et iPad (l'iPad se présente comme un Mac avec écran tactile)
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const WATCHDOG_MS = 6000;

// Journal du micro (diagnostic, visible dans ⚙) : ce que fait la reconnaissance vocale
const micLines = [];
let micT0 = Date.now();
function micLog(text) {
  micLines.push(`${((Date.now() - micT0) / 1000).toFixed(1).padStart(6)} s  ${text}`);
  if (micLines.length > 80) micLines.shift();
}

function startRecognizer() {
  const r = rec.engine === 'server' ? new ServerRecognizer(rec.serverUrl) : new SR();
  r.lang = 'ar-SA';
  rec.lastEventAt = Date.now();
  const seen = () => { if (rec.recognition === r) rec.lastEventAt = Date.now(); };
  r.onstart = () => { seen(); micLog(`démarrage (${r.continuous ? 'continu' : 'par phrase'})`); };
  r.onaudiostart = () => { seen(); micLog('micro ouvert'); };
  r.onspeechstart = () => { seen(); micLog('voix détectée'); };
  r.onspeechend = () => { seen(); micLog('fin de voix'); };
  // Écoute continue : chaque redémarrage du micro fait un bip sur Android et perd
  // les mots prononcés pendant ce temps. On ne relance que si le navigateur coupe.
  r.continuous = !rec.phrase;
  rec.lastResultAt = Date.now();
  r.interimResults = true;
  r.maxAlternatives = 3;
  // les événements d'un micro déjà remplacé (après une reprise) sont ignorés
  r.onresult = (e) => {
    if (rec.recognition !== r) return;
    seen();
    const last = e.results[e.results.length - 1];
    micLog(`${last.isFinal ? 'définitif' : 'provisoire'} (${e.results.length} seg.) : ${last[0].transcript.trim().split(/\s+/).slice(-4).join(' ')}`);
    onResult(e);
  };
  r.onerror = (e) => {
    micLog('erreur : ' + e.error);
    if (e.error === 'network' && rec.engine === 'server') {
      $('#heard').textContent = 'Serveur Hifz injoignable : vérifiez l’adresse dans ⚙ (ou repassez sur « Téléphone »).';
      stopListening();
      return;
    }
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      $('#heard').textContent = 'Accès au micro refusé.';
      stopListening();
    }
  };
  r.onend = () => {
    if (rec.recognition !== r) return;
    micLog('arrêt');
    rec.committed = rec.shown; // garde le dernier résultat provisoire si aucun final n'est arrivé
    newSession();
    if (checkReplay(rec.committed, true)) return;
    if (rec.committed.pos >= rec.words.length) { render(); finish(); return; }
    // relance avec une écoute neuve (Safari refuse parfois de redémarrer l'ancienne)
    if (rec.listening) { rec.recognition = null; startRecognizer(); }
  };
  newSession();
  rec.recognition = r;
  try { r.start(); } catch { stopListening(); }
}

function stopListening() {
  if (rec.listening) micLog('micro coupé');
  rec.listening = false;
  rec.pausing = false;
  if (sayAudio) sayAudio.pause();
  clearInterval(rec.timer);
  if (rec.shown) rec.committed = rec.shown;
  if (rec.recognition) { try { rec.recognition.abort(); } catch { /* déjà arrêté */ } rec.recognition = null; }
  if (window.releaseMic) releaseMic(); // micro du mode serveur
  $('#btn-mic').classList.remove('on');
}

$('#btn-mic').addEventListener('click', () => {
  if (rec.listening) { stopListening(); return; }
  unlockSayAudio();
  startListening();
});
$('#btn-restart').addEventListener('click', resetRecite);
// Nouvelle écoute du micro (démarrage, relance automatique, reprise après un rappel) :
// chacune commence par un bip sur Android, d'où la tolérance sur les premiers mots.
function newSession() {
  rec.base = clone(rec.committed);
  rec.base.grace = GRACE_WORDS;
  rec.base.graceSkip = true;
  rec.base.extra = 0;
  rec.base.pending = [];
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

// Écoute par phrase : le micro est relancé à chaque pause (au lieu d'écouter en continu).
// Sur iPhone, la reconnaissance d'Apple suit parfois mieux ainsi.
$('#opt-phrase').checked = rec.phrase;
$('#opt-phrase').addEventListener('change', () => {
  rec.phrase = $('#opt-phrase').checked;
  store.set('phrase', rec.phrase);
  if (rec.listening) { stopListening(); startListening(); }
});
$('#opt-delay').checked = rec.showDelay;
$('#opt-delay').addEventListener('change', () => {
  rec.showDelay = $('#opt-delay').checked;
  store.set('showDelay', rec.showDelay);
});

$('#waqf').value = rec.waqf;
$('#waqf').addEventListener('change', () => {
  rec.waqf = $('#waqf').value;
  store.set('waqf', rec.waqf);
});

$('#beeps').value = String(rec.beeps);
$('#beeps').addEventListener('change', () => {
  rec.beeps = Number($('#beeps').value);
  store.set('beeps', rec.beeps);
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

// ---------- Installation comme application ----------
// Ouverte dans le navigateur (et non depuis l'icône installée), l'application garde la barre
// d'adresse : on explique comment l'installer.
(function installBanner() {
  const installed = matchMedia('(display-mode: standalone)').matches
    || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  if (installed) return;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const how = $('#install-how');
  how.textContent = ios
    ? "Touchez le bouton Partager (le carré avec une flèche vers le haut), puis « Sur l'écran d'accueil ». Ouvrez ensuite Hifz depuis sa nouvelle icône."
    : "Menu ⋮ du navigateur → « Installer l'application » (ou « Ajouter à l'écran d'accueil »). Ouvrez ensuite Hifz depuis sa nouvelle icône.";
  $('#install-banner').hidden = false;
  // Android (Chrome) : installation directe en un toucher
  let prompt = null;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    prompt = e;
    $('#install-btn').hidden = false;
  });
  $('#install-btn').addEventListener('click', async () => {
    if (!prompt) return;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') $('#install-banner').hidden = true;
    prompt = null;
  });
  addEventListener('appinstalled', () => { $('#install-banner').hidden = true; });
})();

// ---------- Démarrage ----------
loadData();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js');
}
