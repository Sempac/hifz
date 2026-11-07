'use strict';

// ---------- Utilitaires ----------
const $ = (s) => document.querySelector(s);
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};
const arNum = (n) => n.toLocaleString('ar-EG');
const pad3 = (n) => String(n).padStart(3, '0');

// Mushaf clair par défaut, même si le téléphone est en mode sombre (06/11/2026) ; sombre au choix (⚙)
const applyNight = () => {
  const night = store.get('mushafNight', false);
  document.documentElement.dataset.theme = night ? 'dark' : 'light';
  document.querySelectorAll('.opt-night').forEach((c) => { c.checked = night; });
};
document.querySelectorAll('.opt-night').forEach((c) => c.addEventListener('change', () => { store.set('mushafNight', c.checked); applyNight(); }));
applyNight();

// Normalise un mot arabe pour la comparaison : sans voyelles, sans signes coraniques,
// et avec les variantes de lettres ramenées à une seule forme.
function norm(w) {
  return w.normalize('NFC')
    // écriture du mushaf : ى / و + alif suscrit au milieu du mot se lit ā (« التَّوْرَىٰةِ » = التوراة,
    // « الزَّكَوٰةَ » = الزكاة) ; le modèle du serveur écrit ainsi (02/11/2026)
    .replace(/[ىو]ٰ(?=\S*[ء-غف-ي])/g, 'ا')
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

// Niveaux de correction (1 = stricte, 2 = normale, 3 = souple) :
//   tol      part maximale de lettres différentes pour accepter un mot
//   extra    nombre de mots inconnus d'affilée avant de compter le mot attendu comme erreur
//   unsure   nombre de mots sautés d'affilée affichés « non entendu » au lieu d'erreur
//   shortOk  un petit mot (1-2 lettres) sauté seul est accepté
//   insMin   longueur minimale d'un mot en trop pour le signaler (0 = pas de détection)
//   lenient  serveur : « و » / « ف » perdu en début de morceau accepté, et lettre proche (ح/ه, ص/س…)
//            acceptée ; sinon les deux font reprendre le mot (le modèle se trompe parfois)
const LEVELS = {
  1: { tol: 0.34, extra: 2, unsure: 0, shortOk: false, insMin: 2, lenient: false },
  2: { tol: 0.42, extra: 3, unsure: 1, shortOk: false, insMin: 3, lenient: false },
  3: { tol: 0.5, extra: 3, unsure: 1, shortOk: true, insMin: 3, lenient: true },
};

// a et b ne diffèrent que par le « و » / « ف » du début (l'un pour l'autre, ajouté ou oublié) : faute
// de mémoire, pas une transcription approximative (07/11/2026 : « فَكُلَا » dit exprès pour « وَكُلَا »,
// compté juste au niveau souple). Le serveur ne rend le mot attendu que si le modèle hésitait vraiment.
function conjChange(a, b) {
  if (a.length === b.length) return a.length > 2 && a[0] !== b[0] && 'وف'.includes(a[0]) && 'وف'.includes(b[0]) && a.slice(1) === b.slice(1);
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.length >= 2 && 'وف'.includes(l[0]) && l.slice(1) === s;
}

// Deux mots sont considérés identiques s'ils diffèrent d'au plus une part des lettres
// (la reconnaissance vocale n'est pas parfaite). Les mots très courts doivent être exacts.
function same(a, b) {
  if (a === b) return true;
  if (rec.engine === 'server' && conjChange(a, b)) return false; // texte du serveur fiable : « و » ≠ « ف »
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
  return beforeWasl(p).some((x) => startsLike(sw, squeeze(x)) && waslForms(E[p + 1].norm).some((f) => same(sw, squeeze(x + f))));
}

// deux mots entendus collés : le début du mot entendu doit bien être le premier mot (« كَالْكِتَابُ »,
// ذَٰلِكَ à peine dit, n'est pas « ذلك » + « الكتاب », même si l'ensemble se ressemble, 30/10/2026)
function startsLike(w, first) {
  return lev(w.slice(0, first.length), first) <= Math.floor(first.length * LEVELS[rec.level].tol);
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
// presque un mot du Coran (une lettre de différence, 4 lettres ou plus) : « الرِّزْقِا » collé, pas du bruit
let quranByLen = null;
const nearMemo = new Map();
function nearQuranWord(w) {
  if (w.length < 4) return false;
  if (nearMemo.has(w)) return nearMemo.get(w);
  if (!quranByLen) { quranByLen = {}; isQuranWord(''); for (const q of quranVocab) (quranByLen[q.length] ||= []).push(q); }
  let near = false;
  for (let L = w.length - 1; L <= w.length + 1 && !near; L++) for (const q of quranByLen[L] || []) if (lev(w, q) <= 1) { near = true; break; }
  nearMemo.set(w, near);
  return near;
}

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
const views = { home: $('#view-home'), learn: $('#view-learn'), recite: $('#view-recite'), labo: $('#view-labo'), drill: $('#view-drill') };

function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  if (name !== 'learn') { stopAudio(); stopRecording(); }
  if (name === 'home' && window.closeMushaf) closeMushaf();
  if (name !== 'recite') { stopListening(); $('#lens').hidden = true; }
  if (name !== 'labo' && window.stopLabo) window.stopLabo();
  window.scrollTo(0, 0);
}

// replace : changement de mode (Lire / Hifz) — le retour mène à l'écran d'avant, pas à l'autre mode
function go(name, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({ v: name }, '');
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
  // (nom arabe isolé : sinon le nombre de versets se met dans le désordre)
  $('#picker-title').innerHTML = `${s.n}. ${s.en} — <bdi dir="rtl">${s.name}</bdi><br><small>${total} versets</small>`;
  $('#from').max = $('#to').max = total;
  // nouvelle sourate : toute la sourate (1 au dernier verset) ; sinon les versets choisis la dernière fois
  $('#from').value = saved ? saved[0] : 1;
  $('#to').value = saved ? saved[1] : total;
  $('#btn-whole').textContent = `📗 Toute la sourate (versets 1 à ${total})`;
  $('#btn-whole').hidden = !saved || (saved[0] === 1 && saved[1] === total);
  pickerSurah = s;
  $('#picker').hidden = false;
}

$('#btn-whole').addEventListener('click', () => {
  $('#from').value = 1; $('#to').value = pickerSurah.a.length; $('#btn-whole').hidden = true;
});
// toucher une case : son chiffre est sélectionné, le nouveau chiffre tapé le remplace (plus besoin d'effacer)
['#from', '#to'].forEach((id) => $(id).addEventListener('focus', (e) => e.target.select()));

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
let playlist = [], playIdx = 0;

// Autres récitateurs d'everyayah.com (Hafs, en arabe ; une version par récitateur, la plus légère
// de bonne qualité pour les réseaux faibles). Liste écrite ici : aucun chargement en plus (05/11/2026).
const MORE_RECITERS = [
  ['Abdul_Basit_Murattal_64kbps', 'Abdul Basit (Murattal)'], ['Abdul_Basit_Mujawwad_128kbps', 'Abdul Basit (Mujawwad)'],
  ['AbdulSamad_64kbps_QuranExplorer.Com', 'Abdul Samad'], ['Abdullah_Basfar_64kbps', 'Abdullah Basfar'],
  ['Abdullaah_3awwaad_Al-Juhaynee_128kbps', 'Abdullah Al-Juhani'], ['Abdullah_Matroud_128kbps', 'Abdullah Matroud'],
  ['Abdurrahmaan_As-Sudais_64kbps', 'Abdurrahman As-Sudais'], ['Abu_Bakr_Ash-Shaatree_128kbps', 'Abu Bakr Ash-Shatri'],
  ['ahmed_ibn_ali_al_ajamy_128kbps', 'Ahmed Al-Ajamy'], ['Ahmed_Neana_128kbps', 'Ahmed Neana'],
  ['Akram_AlAlaqimy_128kbps', 'Akram Al-Alaqimy'], ['Ali_Hajjaj_AlSuesy_128kbps', 'Ali Hajjaj As-Suesy'],
  ['Hudhaify_128kbps', 'Ali Al-Hudhaifi'], ['Ali_Jaber_64kbps', 'Ali Jaber'], ['Ayman_Sowaid_64kbps', 'Ayman Sowaid'],
  ['aziz_alili_128kbps', 'Aziz Alili'], ['Fares_Abbad_64kbps', 'Fares Abbad'], ['Hani_Rifai_64kbps', 'Hani Ar-Rifai'],
  ['Husary_128kbps_Mujawwad', 'Husary (Mujawwad)'], ['Ibrahim_Akhdar_32kbps', 'Ibrahim Al-Akhdar'],
  ['Karim_Mansoori_40kbps', 'Karim Mansouri'], ['Khaalid_Abdullaah_al-Qahtaanee_192kbps', 'Khalid Al-Qahtani'],
  ['khalefa_al_tunaiji_64kbps', 'Khalifa At-Tunaiji'], ['MaherAlMuaiqly128kbps', 'Maher Al-Muaiqly'],
  ['mahmoud_ali_al_banna_32kbps', 'Mahmoud Ali Al-Banna'], ['Minshawy_Mujawwad_64kbps', 'Minshawi (Mujawwad)'],
  ['Mohammad_al_Tablaway_128kbps', 'Mohammad At-Tablawi'], ['Muhammad_AbdulKareem_128kbps', 'Muhammad Abdulkareem'],
  ['Muhammad_Ayyoub_128kbps', 'Muhammad Ayyoub'], ['Muhammad_Jibreel_128kbps', 'Muhammad Jibreel'],
  ['Muhsin_Al_Qasim_192kbps', 'Muhsin Al-Qasim'], // (Mustafa Ismail retiré : versets manquants, ex. 3:13)
  ['Nasser_Alqatami_128kbps', 'Nasser Al-Qatami'], ['Parhizgar_48kbps', 'Parhizgar'],
  ['Ghamadi_40kbps', 'Saad Al-Ghamdi'], ['Sahl_Yassin_128kbps', 'Sahl Yassin'],
  ['Salaah_AbdulRahman_Bukhatir_128kbps', 'Salah Bukhatir'], ['Salah_Al_Budair_128kbps', 'Salah Al-Budair'],
  ['Saood_ash-Shuraym_128kbps', 'Saud Ash-Shuraym'], ['Yaser_Salamah_128kbps', 'Yaser Salamah'],
  ['Yasser_Ad-Dussary_128kbps', 'Yasser Ad-Dussary'],
];

// Récitateur choisi dans « Autres » : ajouté à la liste courte (avant « 🔍 Autres récitateurs… »)
function ensureReciterOption(value) {
  const sel = $('#reciter');
  if ([...sel.options].some((o) => o.value === value)) return;
  const r = MORE_RECITERS.find(([v]) => v === value);
  if (!r) return;
  sel.insertBefore(new Option(r[1], r[0]), sel.querySelector('option[value="__more"]'));
}

let reciterBefore = store.get('reciter', 'Husary_Muallim_128kbps');
ensureReciterOption(reciterBefore);
$('#reciter').value = reciterBefore;
$('#repeat').value = store.get('repeat', '3');
$('#reciter').addEventListener('change', () => {
  const v = $('#reciter').value;
  if (v === '__more') { openReciterSheet(); return; }
  reciterBefore = v;
  store.set('reciter', v);
});
$('#repeat').addEventListener('change', () => store.set('repeat', $('#repeat').value));

// s'ouvre par-dessus les réglages d'Apprendre : placé en fin de page
document.body.append($('#reciter-sheet'));
function openReciterSheet() {
  $('#reciter-search').value = '';
  renderReciters();
  $('#reciter-sheet').hidden = false;
}
function renderReciters() {
  const q = $('#reciter-search').value.trim().toLowerCase();
  const ul = $('#reciter-list');
  ul.innerHTML = '';
  for (const [v, name] of MORE_RECITERS) {
    if (q && !name.toLowerCase().includes(q)) continue;
    const b = document.createElement('button');
    b.className = 'btn' + (v === reciterBefore ? ' on' : '');
    b.textContent = name;
    b.addEventListener('click', () => {
      ensureReciterOption(v);
      $('#reciter').value = reciterBefore = v;
      store.set('reciter', v);
      $('#reciter-sheet').hidden = true;
    });
    ul.appendChild(b);
  }
}
$('#reciter-search').addEventListener('input', renderReciters);
// fermé sans choisir : on revient au récitateur d'avant (pas « Autres… » dans la liste)
new MutationObserver(() => { if ($('#reciter-sheet').hidden && $('#reciter').value === '__more') $('#reciter').value = reciterBefore; })
  .observe($('#reciter-sheet'), { attributes: true, attributeFilter: ['hidden'] });

// La sélection couvre-t-elle plusieurs sourates ? (on affiche alors le nom de chaque sourate)
const multiSurah = () => current.ayahs.some((x) => x.s !== current.ayahs[0].s);

function openLearn(startPage, replace = false) {
  $('#learn-title').textContent = rangeTitle();
  $('#learn-msg').hidden = true;
  const box = $('#learn-text');
  box.innerHTML = '';
  const multi = multiSurah();
  let prevS = 0;
  for (const x of current.ayahs) {
    if (multi && x.s !== prevS) box.appendChild(surahHead(x.s));
    prevS = x.s;
    const q = startsQuarter(x.s, x.a);
    if (q) box.appendChild(quarterHead(q));
    const span = document.createElement('span');
    span.className = 'ayah';
    span.dataset.k = ayahKey(x);
    span.innerHTML = `${ayahText(x)} <span class="mark">﴿${arNum(x.a)}﴾</span> `;
    span.addEventListener('click', () => play([x]));
    box.appendChild(span);
  }
  go('learn', replace);
  applyLearnView(startPage);
}

// ---------- Changer de mode sur les mêmes versets (coin en bas à droite) ----------
// Lire / Écouter → Hifz : la récitation repart du début de la sélection.
$('#learn-mode').addEventListener('click', () => openRecite(true));
// Hifz → Lire / Écouter : sur la page affichée.
$('#recite-mode').addEventListener('click', () => openLearn(framePage.recite || undefined, true));

// Apprendre, affichage texte : en faisant défiler, le cadre suit le verset au milieu de l'écran
// (numéro de page et quart de hizb en bas)
document.addEventListener('scroll', () => {
  if (views.learn.hidden || learnView !== 'text') return;
  cancelAnimationFrame(updateFrame.f);
  updateFrame.f = requestAnimationFrame(() => {
    const r = $('#learn-text').getBoundingClientRect(), y = Math.max(r.top, 0) + Math.min(r.height, innerHeight) / 2;
    // (un peu plus bas ou plus haut si le milieu tombe sur un titre ou entre deux lignes)
    const el = [0, 24, -24, 48, -48].map((dy) => document.elementFromPoint(r.left + r.width / 2, y + dy)?.closest('.ayah')).find(Boolean);
    if (!el) return;
    const [s, a] = el.dataset.k.split(':').map(Number);
    if (QURAN[s - 1].p[a - 1] !== framePage.learn || QURAN[s - 1].q[a - 1] !== frameQuarter.learn) updateFrame('learn', QURAN[s - 1].p[a - 1], QURAN[s - 1].q[a - 1]);
  });
}, true);

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
  if (!paged) { closeMushaf(); $('#tajweed-legend').hidden = true; updateFrame('learn', QURAN[f.s - 1].p[f.a - 1]); return; }
  const host = $('#learn-book');
  const keys = new Set(current.ayahs.map(ayahKey));
  const [first, last] = await selectionPages();
  await document.fonts.ready; // le cadre a sa taille définitive
  await nextFrame();
  mushaf.onFlip = (n) => updateFrame('learn', n);
  mushaf.tajweed = store.get('tajweed', true); // couleurs du tajwid (⚙ du mode Lire)
  $('#tajweed-legend').hidden = !mushaf.tajweed;
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

$('#opt-tajweed').checked = store.get('tajweed', true);
$('#opt-tajweed').addEventListener('change', () => {
  store.set('tajweed', $('#opt-tajweed').checked);
  if (learnView === 'page' && mushaf.flip) applyLearnView(mushafCurrentPage());
});

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

// Lecture continue (06/11/2026, demande utilisateur : « on sent une coupure entre les versets ») :
// un fichier par verset, mais le suivant est téléchargé et décodé pendant la lecture du verset en
// cours, puis enchaîné à l'échantillon près (Web Audio). Les silences des fichiers sont très
// inégaux (Husary : 0,6 s au début + 1,5 s à la fin ; Afasy, Soudais : rien, coupé net) : ils sont
// retirés et remplacés par une même respiration de VERSE_GAP entre deux versets.
const VERSE_GAP = 0.6;    // pause entre deux versets (s)
const AUDIO_AHEAD = 2;    // le verset suivant est programmé 2 s avant la fin du verset en cours
const player = { ctx: null, gen: 0, sources: [], cache: new Map() };
const audioCtx = () => (player.ctx ||= new (window.AudioContext || window.webkitAudioContext)());

// Récitation enregistrée d'un seul tenant (v79, 06/11/2026) : même enchaînés sans trou, les fichiers
// par verset restent coupés là où le récitateur, lui, continue (36:3-4 « الْمُرْسَلِينَ عَلَىٰ صِرَاطٍ »
// lu d'une traite, le fichier du verset 3 s'arrête au milieu du « نَ »). Pour ces récitateurs, Quran.com
// fournit la sourate entière en un fichier + l'heure de début et de fin de chaque verset : on lit ce
// fichier en continu, sans aucune coupure, et on ne saute qu'à une répétition ou à la fin de la sélection.
// Valeur du choix « récitateur » (dossier everyayah) → numéro de récitation Quran.com (nombre), ou
// [numéro de lecture, dossier] sur mp3quran.net (v80 : même principe, autres récitateurs, Hafs seulement)
const SURAH_AUDIO = {
  Husary_Muallim_128kbps: 12, Husary_128kbps: 6, Minshawy_Murattal_128kbps: 9, Alafasy_128kbps: 7,
  Abdul_Basit_Murattal_64kbps: 2, Abdul_Basit_Mujawwad_128kbps: 1, 'Abdurrahmaan_As-Sudais_64kbps': 3,
  'Abu_Bakr_Ash-Shaatree_128kbps': 4, Hani_Rifai_64kbps: 5, 'Saood_ash-Shuraym_128kbps': 10,
  khalefa_al_tunaiji_64kbps: 161, 'Yasser_Ad-Dussary_128kbps': 97,
  Ghamadi_40kbps: [30, 'saad-ghamdi/r1'], Abdullah_Basfar_64kbps: [60, 'abdullah-basfar/r1'],
  'Abdullaah_3awwaad_Al-Juhaynee_128kbps': [62, 'abdullah-juhani/r1'], Abdullah_Matroud_128kbps: [59, 'abdullah-matrood/r1'],
  ahmed_ibn_ali_al_ajamy_128kbps: [5, 'ahmad-ajmi/r1'], Ahmed_Neana_128kbps: [9, 'ahmad-naina/r1'],
  Akram_AlAlaqimy_128kbps: [10, 'akram-alaqmi/r1'], Ali_Hajjaj_AlSuesy_128kbps: [77, 'ali-souissi/r1'],
  Hudhaify_128kbps: [74, 'ali-hudhaifi/r1'], Ali_Jaber_64kbps: [76, 'ali-jaber/r1'], Fares_Abbad_64kbps: [81, 'fares-abbad/r1'],
  Husary_128kbps_Mujawwad: [119, 'mahmoud-husary/r2'], Ibrahim_Akhdar_32kbps: [1, 'ibrahim-akhdar/r1'],
  'Khaalid_Abdullaah_al-Qahtaanee_192kbps': [21, 'khalid-qahtani/r1'], Mohammad_al_Tablaway_128kbps: [106, 'muhammad-tablawi/r1'],
  Muhammad_AbdulKareem_128kbps: [115, 'muhammad-abdulkareem/r1'], Muhammad_Ayyoub_128kbps: [109, 'muhammad-ayyub/r1'],
  Muhsin_Al_Qasim_192kbps: [67, 'abdulmohsen-qasim/r1'], Nasser_Alqatami_128kbps: [86, 'nasser-qatami/r1'],
  Sahl_Yassin_128kbps: [32, 'sahl-yassin/r1'], Salaah_AbdulRahman_Bukhatir_128kbps: [46, 'salah-bukhatir/r1'],
  Salah_Al_Budair_128kbps: [43, 'salah-budair/r1'],
};
const surahEl = new Audio(); // lecteur du fichier de la sourate (continue aussi écran éteint)
surahEl.preload = 'auto';
const surahTimingCache = new Map();
// { url, at: { verset: [début, fin] (s) } } d'une sourate pour une récitation Quran.com
function surahTimings(id, s) {
  const key = `${id}:${s}`;
  if (!surahTimingCache.has(key) && Array.isArray(id)) {
    // mp3quran.net : [{ ayah, start_time, end_time }] en ms (ayah 0 = isti'adha/basmala, ignorée)
    const p = fetch(`https://www.mp3quran.net/api/v3/ayat_timing?surah=${s}&read=${id[0]}`)
      .then((r) => { if (!r.ok) throw new Error(`minutage ${r.status}`); return r.json(); })
      .then((list) => {
        const at = {};
        for (const v of list) if (v.ayah > 0) at[v.ayah] = [v.start_time / 1000, v.end_time / 1000];
        if (!Object.keys(at).length) throw new Error('minutage vide');
        return { url: `https://cdn.mp3quran.net/audio/${id[1]}/${pad3(s)}.mp3`, at };
      });
    p.catch(() => surahTimingCache.delete(key));
    surahTimingCache.set(key, p);
  }
  if (!surahTimingCache.has(key)) {
    const p = fetch(`https://api.qurancdn.com/api/qdc/audio/reciters/${id}/audio_files?chapter=${s}&segments=true`)
      .then((r) => { if (!r.ok) throw new Error(`minutage ${r.status}`); return r.json(); })
      .then((j) => {
        const f = j.audio_files[0], at = {};
        for (const v of f.verse_timings) at[+v.verse_key.split(':')[1]] = [v.timestamp_from / 1000, v.timestamp_to / 1000];
        if (!f.audio_url || !Object.keys(at).length) throw new Error('minutage vide');
        return { url: f.audio_url, at };
      });
    p.catch(() => surahTimingCache.delete(key));
    surahTimingCache.set(key, p);
  }
  return surahTimingCache.get(key);
}

// Son d'un verset : { buf, from, to } (début et fin de la voix, en s) ; null si pas d'enregistrement
function loadAyahAudio(x, reciter) {
  const key = `${reciter}|${ayahKey(x)}`;
  if (!player.cache.has(key)) {
    const p = (async () => {
      let data;
      if (reciter === 'me') {
        const saved = await idbGet(ayahKey(x));
        if (!saved) return null;
        data = saved.buf.slice(0);
      } else {
        const r = await fetch(`https://everyayah.com/data/${reciter}/${pad3(x.s)}${pad3(x.a)}.mp3`);
        if (!r.ok) throw new Error(`audio ${r.status}`);
        data = await r.arrayBuffer();
      }
      const buf = await new Promise((ok, ko) => audioCtx().decodeAudioData(data, ok, ko));
      // voix = trames de 20 ms à moins de 40 dB sous la plus forte ; on garde 60 ms de marge
      const d = buf.getChannelData(0), fr = Math.round(buf.sampleRate * 0.02), rms = [];
      for (let i = 0; i + fr <= d.length; i += fr) {
        let s = 0;
        for (let j = i; j < i + fr; j++) s += d[j] * d[j];
        rms.push(Math.sqrt(s / fr));
      }
      const th = Math.max(...rms) * 0.01;
      const first = rms.findIndex((v) => v > th), last = rms.findLastIndex((v) => v > th);
      if (first < 0) return { buf, from: 0, to: buf.duration };
      return { buf, from: Math.max(0, first * 0.02 - 0.06), to: Math.min(buf.duration, (last + 1) * 0.02 + 0.06) };
    })();
    p.catch(() => player.cache.delete(key));
    player.cache.set(key, p);
    if (player.cache.size > 12) player.cache.delete(player.cache.keys().next().value); // mémoire bornée
  }
  return player.cache.get(key);
}

function play(ayahs) {
  stopAudio();
  if (IOS) {
    // iPhone / iPad : le son de Web Audio (versets enchaînés) est coupé par le bouton silencieux,
    // sauf en mode « lecture » (Safari 17+) ; pendant la récitation, le micro le remet en « auto »
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    // le lecteur de la sourate n'a le droit de jouer après le téléchargement du minutage que s'il a
    // déjà joué pendant un toucher : on le lance ici une fois sur un silence
    if (!player.surahUnlocked) {
      player.surahUnlocked = true;
      surahEl.src = SILENCE;
      surahEl.play().catch(() => { player.surahUnlocked = false; });
    }
  }
  const rep = parseInt($('#repeat').value, 10);
  playlist = ayahs.flatMap((x) => Array(rep).fill(x));
  playIdx = 0;
  $('#btn-play').textContent = '⏸';
  runPlaylist(++player.gen, $('#reciter').value);
}

// verset entendu à partir de maintenant : surligné (texte ou livre)
function showPlaying(x) {
  document.querySelectorAll('.ayah.playing').forEach((el) => el.classList.remove('playing'));
  const el = document.querySelector(`.ayah[data-k="${ayahKey(x)}"]`);
  if (el && learnView === 'text') { el.classList.add('playing'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  markBookAyah(ayahKey(x), 'playing');
}

async function runPlaylist(gen, reciter) {
  const ctx = audioCtx();
  const live = () => gen === player.gen;
  // attend que l'horloge du son atteigne t (en s) ; false si la lecture a été arrêtée
  const until = async (t) => {
    while (live() && ctx.currentTime < t) await new Promise((r) => setTimeout(r, Math.min(250, (t - ctx.currentTime) * 1000)));
    return live();
  };
  try { await ctx.resume(); } catch { /* déjà actif */ }
  let t = 0; // fin du verset programmé en dernier (horloge du son)
  const id = SURAH_AUDIO[reciter];
  let follow = false; // le fichier de la sourate est déjà en train de lire ce verset (suite directe)
  for (; playIdx < playlist.length; playIdx++) {
    const x = playlist[playIdx];
    // récitation d'un seul tenant (fichier de la sourate)
    let tm = null;
    if (id) { try { tm = await surahTimings(id, x.s); } catch { tm = null; } }
    if (!live()) return;
    const span = tm && tm.at[x.a];
    if (span) {
      if (t && !(await until(t))) return; // un verset lu par l'autre méthode se termine d'abord
      t = 0;
      if (!follow) {
        if (surahEl.src !== tm.url) surahEl.src = tm.url;
        surahEl.currentTime = span[0];
        try { await surahEl.play(); } catch { showLearnMsg('Récitation introuvable (réseau ?).'); break; }
        if (!live()) { surahEl.pause(); return; }
      }
      showPlaying(x);
      const nx = playlist[playIdx + 1];
      follow = !!(nx && nx.s === x.s && nx.a === x.a + 1 && tm.at[nx.a]); // verset suivant : on laisse lire
      const end = follow ? tm.at[nx.a][0] : span[1];
      while (live() && !surahEl.ended && surahEl.currentTime < end) await new Promise((r) => setTimeout(r, 40));
      if (!live()) return;
      if (!follow) surahEl.pause();
      continue;
    }
    follow = false;
    let seg;
    try { seg = await loadAyahAudio(x, reciter); } catch { seg = undefined; }
    if (!live()) return;
    if (playlist[playIdx + 1]) loadAyahAudio(playlist[playIdx + 1], reciter).catch(() => {}); // le suivant, en avance
    if (seg === null) {
      showLearnMsg(`Verset ${QURAN[x.s - 1].en} ${x.a} pas encore enregistré avec votre voix.`);
      continue;
    }
    if (!seg) { showLearnMsg('Récitation introuvable (réseau ?).'); break; }
    const at = Math.max(t ? t + VERSE_GAP : 0, ctx.currentTime + 0.05), len = seg.to - seg.from;
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = seg.buf;
    // fondu de 20 ms aux deux bouts : pas de « clic » là où le silence a été coupé
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(1, at + 0.02);
    g.gain.setValueAtTime(1, at + len - 0.02);
    g.gain.linearRampToValueAtTime(0, at + len);
    src.connect(g).connect(ctx.destination);
    src.start(at, seg.from, len);
    player.sources.push(src);
    t = at + len;
    if (!(await until(at))) return;
    showPlaying(x);
    if (!(await until(t - AUDIO_AHEAD))) return;
  }
  if (await until(t)) stopAudio();
}

function stopAudio() {
  player.gen++;
  player.sources.forEach((s) => { try { s.stop(); } catch { /* déjà fini */ } });
  player.sources = [];
  surahEl.pause();
  playlist = [];
  document.querySelectorAll('.ayah.playing, .mw.playing').forEach((el) => el.classList.remove('playing'));
  $('#btn-play').textContent = '▶';
}
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
    player.cache.delete(`me|${key}`); // la lecture reprendra le nouvel enregistrement
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
  // (anciens réglages sur 5 niveaux : 1-2 → stricte, 3 → normale, 4-5 → souple)
  level: store.get('level3', [1, 1, 1, 2, 3, 3][store.get('level', store.get('severity', 'soft') === 'strict' ? 2 : 4)]),
  overrides: new Set(), // mots marqués justes à la main par l'utilisateur
  forcedBad: new Set(), // mots marqués faux à la main (appui long)
  counted: new Set(),   // mots déjà pris en compte par l'apprentissage automatique
  flagged: new Set(),   // mots signalés comme fautes (✗) pendant cette récitation
  reviewOut: null,      // mots sortis de « À revoir » à la fin de cette récitation (null : pas encore compté)
  replay: store.get('replay', true), // reprise sur erreur
  beeps: store.get('beeps', 1),      // signaux (on reprend seul) avant le rappel prononcé
  // signal d'erreur : écran rouge + tic de 0,04 s (micro ouvert), écran rouge seul, ou bip ; l'ancien
  // défaut « flash » passe une fois au tic (écran seul jugé insuffisant, pas de vibration, 01/11/2026)
  ahkam: store.get('ahkam', false), // 2.0 : remarques de tajwīd (longueur des madd), pron.js
  // 05/11/2026 : « tic » et bip remplacés une fois par le bip de montre (plus court, plus aigu, retiré du son envoyé)
  signal: (() => {
    if (!store.get('signalTick')) { store.set('signalTick', 1); if (store.get('signal') === 'flash') store.set('signal', 'tick'); }
    if (!store.get('signalWatch')) { store.set('signalWatch', 1); if (['tick', 'beep'].includes(store.get('signal', 'tick'))) store.set('signal', 'watch'); }
    return store.get('signal', 'watch');
  })(),
  waqf: store.get('waqf', 'rec'),    // signes d'arrêt (WAQF_SHOWN)
  // écoute par phrase (au lieu de continue) : par défaut sur iPhone / iPad, où Safari suit mieux ainsi
  phrase: store.get('phrase', /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)),
  lastEventAt: 0,       // dernière nouvelle de la reconnaissance (chien de garde iPhone / iPad)
  lensZoom: Number(store.get('lensZoom', 1.6)), // loupe sur la ligne en cours (0 = désactivée)
  // reconnaissance : 'device' (Google / Apple) ou 'server' (serveur Hifz) ; serveur par défaut sur un nouvel
  // appareil (l'iPad, jamais réglé, restait sur la reconnaissance de Safari, absente : micro grisé, 07/11/2026)
  engine: store.get('engine', 'server'),
  serverUrl: store.get('serverUrl', ''),   // adresse WebSocket du serveur Hifz
  lensTarget: null,     // mot attendu dans le livre (suivi par la loupe)
  showDelay: store.get('showDelay', false), // afficher l'attente entre deux réponses du micro
  recentHeard: [], // mots entendus récemment, mot du Coran ou non (pause automatique)
  lastResultAt: 0,      // heure de la dernière réponse du micro
  noReplay: new Set(),  // erreurs vues dans une réponse en retard : marquées, sans rappel
  retries: {},          // mot → nombre de reprises
  posAt: {},            // mot → moment où il a été reconnu (diagnostic des rappels)
  firstErr: {},         // mot → nature de l'erreur à la première reprise (bilan)
  firstSaid: {},        // mot → ce qui a été dit à sa place à la première reprise (bilan : « vient de »)
  letterFaults: {},     // mot → { exp, got } : lettre attendue dite comme une autre (bilan, lettres à travailler)
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
const newState = () => ({ pos: 0, marks: [], extra: 0, pending: [], heard: {}, ins: {}, vow: {}, pron: {}, grace: 0, graceSkip: true });
// back : mot faux où revenir après un signal (-1 : aucun) ; ignored : mots dits plus loin, ignorés en attendant
// pron : lettres du mot et leur probabilité (serveur), pour le niveau de prononciation (pron.js)
const clone = (st) => ({ pos: st.pos, marks: st.marks.slice(), extra: st.extra, pending: st.pending.slice(), heard: { ...st.heard }, ins: { ...st.ins }, vow: { ...st.vow }, pron: { ...st.pron }, grace: st.grace, graceSkip: st.graceSkip, back: st.back ?? -1, ignored: st.ignored || 0 });
// probabilité des lettres de chaque mot entendu (serveur), dans l'ordre des mots passés à align
let alignPron = null;
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
  if (j >= 0) { el.textContent = WAQF_LABEL[rec.words[j].stop]; requestAnimationFrame(placeWaqf); }
}

// L'étiquette d'arrêt se pose juste au-dessus de la ligne en cours (ou de la loupe) : en bas de
// l'écran, on ne la voyait pas en récitant (01/11/2026). Au-dessous si la ligne est tout en haut.
// Les messages (mots entendus, explication d'une erreur) se posent en bandeau juste sous la ligne en
// cours, là où sont les yeux : la petite ligne tout en bas, on n'avait pas le temps de la lire en
// récitant (01/11/2026). Au-dessus de la ligne s'il n'y a pas la place dessous.
function placeWaqf() {
  const lens = $('#lens');
  const anchor = !lens.hidden ? lens : document.querySelector('#view-recite .current');
  if (!anchor || views.recite.hidden) return;
  const r = anchor.getBoundingClientRect(), vr = views.recite.getBoundingClientRect();
  let below = r.bottom + 6, above = r.top - 6;
  const el = $('#waqf-sign');
  if (!el.hidden) {
    const h = el.offsetHeight || 28;
    if (above - h < 50) { el.style.top = below + 'px'; below += h + 6; } else { el.style.top = above - h + 'px'; above -= h + 6; }
  }
  const items = [$('#heard'), $('#pron-note'), $('#fix')].filter((x) => !x.hidden && x.textContent && !x.closest('.talk'));
  const total = items.reduce((s, x) => s + x.offsetHeight + 6, 0);
  let y = below + total > vr.bottom - 40 && above - total > vr.top + 46 ? above - total : below;
  for (const x of items) { x.style.top = y + 'px'; y += x.offsetHeight + 6; }
}
// texte ou explication qui change, page qui défile : le bandeau suit
const placeSoon = () => { cancelAnimationFrame(placeSoon.f); placeSoon.f = requestAnimationFrame(placeWaqf); };
for (const id of ['#heard', '#pron-note', '#fix']) new MutationObserver(placeSoon).observe($(id), { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
document.addEventListener('scroll', placeSoon, true);
// cadre du bas : texte arabe entendu en grand, messages en français en taille normale
new MutationObserver(() => $('#heard').classList.toggle('latin', /[A-Za-z]/.test($('#heard').textContent)))
  .observe($('#heard'), { childList: true, characterData: true, subtree: true });
addEventListener('resize', placeSoon);

function openRecite(replace = false) {
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
    const q = startsQuarter(x.s, x.a);
    if (q) box.appendChild(quarterHead(q));
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
  go('recite', replace);
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
  views.recite.style.removeProperty('--talk-h');
  if (!paged) { closeMushaf(); $('#lens').hidden = true; render(); return; } // le cadre suit le mot attendu (render)
  const keys = new Set(current.ayahs.map(ayahKey));
  const [first, last] = await selectionPages();
  await document.fonts.ready;
  await nextFrame();
  const w0 = rec.words[Math.min(rec.shown.pos, rec.words.length - 1)];
  mushaf.onFlip = (n) => {
    const w = rec.words[Math.min(rec.shown.pos, rec.words.length - 1)];
    updateFrame('recite', n, w && QURAN[w.s - 1].p[w.ayah - 1] === n ? QURAN[w.s - 1].q[w.ayah - 1] : 0);
    setTimeout(() => updateLens(rec.lensTarget), 60);
  };
  mushaf.tajweed = false; // Hifz : mots cachés et couleurs juste/faux → police d'une seule couleur
  await openMushaf($('#recite-book'), first, last, (s, a) => keys.has(`${s}:${a}`), startPage || QURAN[w0.s - 1].p[w0.ayah - 1], fitReciteBook);
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

// Mode livre, écran coupé en deux : la page prend toute la largeur (lignes à leur taille maximale)
// et le cadre du bas garde la hauteur qui reste, au moins 150 px (05/11/2026).
function fitReciteBook(need) {
  const host = $('#recite-book');
  const talk = views.recite.clientHeight * 0.44 - (need - host.clientHeight);
  views.recite.style.setProperty('--talk-h', `${Math.round(Math.min(Math.max(talk, 150), views.recite.clientHeight * 0.6))}px`);
  return host.clientHeight;
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
  if (!rec.book || !z || !target || views.recite.hidden || !$('#summary').hidden) { lens.hidden = true; views.recite.classList.remove('lensed'); placeSoon(); return; }
  views.recite.classList.add('lensed'); // la page sous la loupe est estompée
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
  // (écran large, iPad en paysage : au plus 1,6 fois la page, loupe centrée sur elle)
  lens.style.left = lens.style.right = '';
  const lensW = lens.clientWidth;
  const sx = Math.min((lensW - 12) / contentW, Math.max(z, 1.6));
  const side = Math.max(0, (lensW - 12 - contentW * sx) / 2);
  lens.style.left = lens.style.right = side + 'px';
  const sy = Math.max(sx, z);
  const lensH = rows.length * f * 1.6 * sy + 8;
  lens.style.height = lensH + 'px';
  inner.style.transform = `translateX(6px) scale(${sx}, ${sy})`;
  // vertical : centré sur la ligne en cours, dans les limites du cadre
  const minTop = views.recite.querySelector('.fhead').getBoundingClientRect().bottom;
  const maxBottom = views.recite.querySelector('.ffoot').getBoundingClientRect().top;
  const top = Math.max(minTop, Math.min(lr.top + lr.height / 2 - lensH / 2, maxBottom - lensH));
  lens.style.top = top + 'px';
  setTimeout(placeWaqf, 300); // après le glissement de la loupe (.25 s)
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
// le panneau est sorti de l'écran de récitation pour s'ouvrir aussi depuis l'accueil (⚙ à côté
// du Labo) ; ouvert de l'accueil, les boutons propres à une récitation sont cachés
document.body.append($('#settings'));
function openSettings(fromHome) {
  $('#mic-log').textContent = [
    `Appareil : ${IOS ? 'iPhone / iPad' : 'autre'} · écoute ${rec.phrase ? 'par phrase' : 'continue'} · niveau ${rec.level}`,
    navigator.userAgent, '', ...micLines,
  ].join('\n') || '(vide)';
  $('#settings').classList.toggle('from-home', fromHome);
  $('#settings').hidden = false;
}
$('#btn-settings').addEventListener('click', () => openSettings(false));
$('#home-gear').addEventListener('click', () => openSettings(true));
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
const frameQuarter = { learn: 0, recite: 0 };

// Quart de hizb (1 à 240) en toutes lettres : « ۞ نصف الحزب ٥ »
function quarterLabel(q) {
  return `۞ ${['الحزب', 'ربع الحزب', 'نصف الحزب', 'ثلاثة أرباع الحزب'][(q - 1) % 4]} ${arNum(Math.ceil(q / 4))}`;
}

// Le verset ouvre-t-il un quart de hizb ? (pour le repère ۞ dans l'affichage texte)
function startsQuarter(s, a) {
  const q = QURAN[s - 1].q[a - 1];
  const prev = a > 1 ? QURAN[s - 1].q[a - 2] : s > 1 ? QURAN[s - 2].q.at(-1) : 0;
  return q !== prev ? q : 0;
}

// Repère de quart de hizb dans le texte continu, comme le ۞ des pages du mushaf (05/11/2026)
function quarterHead(q) {
  const div = document.createElement('div');
  div.className = 'rub-head';
  div.textContent = quarterLabel(q);
  return div;
}

// Réduit la police d'un cartouche tant que son texte déborde (noms longs : « الجزء الحادي والعشرون »)
function fitCart(el) {
  el.style.fontSize = '';
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (el.scrollWidth > el.clientWidth && size > 12) el.style.fontSize = `${--size}px`;
}
document.fonts.ready.then(() => document.querySelectorAll('.cart').forEach(fitCart));

// page : page affichée ; q : quart de hizb du verset en cours (sinon celui du haut de la page).
// En bas du cadre : numéro de page et quart de hizb, qui clignotent quand ils changent.
async function updateFrame(name, page, q) {
  if (!page) return;
  const turned = framePage[name] && framePage[name] !== page;
  framePage[name] = page;
  const view = views[name];
  const d = await mushafPageData(page);
  const w = d.w.find((x) => x[4] > 0) || d.w[0]; // premier mot de la page
  const s = w[2], a = w[3];
  q ||= QURAN[s - 1].q[a - 1];
  const newQ = frameQuarter[name] && frameQuarter[name] !== q;
  frameQuarter[name] = q;
  view.querySelector('.c-surah').textContent = `سورة ${QURAN[s - 1].name}`;
  view.querySelector('.c-juz').textContent = `الجزء ${JUZ[Math.ceil(QURAN[s - 1].q[a - 1] / 8) - 1]}`;
  // étoile des favoris dans le cartouche du numéro de page (le coin sert à changer de mode)
  const pg = view.querySelector('.c-page');
  const on = !!favs[page] || allAyahs().some((x) => x.p === page && favVerses[ayahKey(x)]);
  pg.textContent = `${on ? '★' : '☆'} ${arNum(page)}`;
  pg.classList.toggle('fav-on', on);
  view.querySelector('.c-rub').textContent = quarterLabel(q);
  view.querySelectorAll('.cart').forEach(fitCart);
  const flash = (el) => { el.classList.remove('changed'); void el.offsetWidth; el.classList.add('changed'); };
  if (turned) flash(pg);
  if (newQ) flash(view.querySelector('.c-rub'));
}

// ---------- Favoris : pages marquées d'une étoile ----------
// toucher le cartouche du numéro de page (☆ ٥٠) ouvre un petit menu : la page entière, ou un des
// versets de la page (05/11/2026)
const favs = store.get('favs', {}); // { page: date d'ajout }
const favVerses = store.get('favVerses', {}); // { "s:a": date d'ajout }
let favView = 'learn';
document.querySelectorAll('.c-page').forEach((b) => b.addEventListener('click', () => {
  favView = b.closest('#view-learn') ? 'learn' : 'recite';
  if (framePage[favView]) openFavSheet(framePage[favView]);
}));

function openFavSheet(p) {
  $('#fav-title').textContent = `Favoris · page ${p}`;
  const pageBtn = $('#fav-page');
  pageBtn.textContent = `${favs[p] ? '★' : '☆'} Page ${p} entière`;
  pageBtn.classList.toggle('on', !!favs[p]);
  pageBtn.onclick = () => toggleFav(favs, 'favs', p, p);
  const box = $('#fav-verses');
  box.innerHTML = '';
  for (const x of allAyahs().filter((y) => y.p === p)) {
    const k = ayahKey(x);
    const b = document.createElement('button');
    b.className = 'btn fav-item' + (favVerses[k] ? ' on' : '');
    // le début du verset dans son propre bloc : l'arabe ne se mélange pas au texte français
    b.innerHTML = `<span>${favVerses[k] ? '★' : '☆'} ${QURAN[x.s - 1].en} ${x.a}</span><bdi dir="rtl" lang="ar"></bdi>`;
    b.querySelector('bdi').textContent = ayahText(x).split(/\s+/).slice(0, 3).join(' ') + ' …';
    b.onclick = () => toggleFav(favVerses, 'favVerses', k, p);
    box.appendChild(b);
  }
  $('#fav-sheet').hidden = false;
}

function toggleFav(obj, key, k, p) {
  if (obj[k]) delete obj[k]; else obj[k] = Date.now();
  store.set(key, obj);
  updateFrame(favView, p, frameQuarter[favView]);
  renderFavs();
  openFavSheet(p);
}

const pageSelection = (p) => ({ title: `Page ${p}`, ayahs: allAyahs().filter((x) => x.p === p) });

function renderFavs() {
  const ul = $('#fav-list');
  ul.innerHTML = '';
  const pages = Object.keys(favs).map(Number).sort((x, y) => x - y);
  const verses = Object.keys(favVerses).map((k) => k.split(':').map(Number)).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  if (!pages.length && !verses.length) { ul.innerHTML = '<li><span class="rinfo">Aucun favori.</span></li>'; return; }
  for (const [s, a] of verses) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="rw">★</span><span class="rinfo">${QURAN[s - 1].en} ${a} · page ${QURAN[s - 1].p[a - 1]}</span>`
      + '<button aria-label="Lire / Écouter">📖</button><button aria-label="Hifz">🧠</button><button aria-label="Retirer">✕</button>';
    const [bl, br, bx] = li.querySelectorAll('button');
    const sel = () => ({ title: `${QURAN[s - 1].en} ${a}`, ayahs: [{ s, a }] });
    bl.addEventListener('click', () => { current = sel(); openLearn(); });
    br.addEventListener('click', () => { current = sel(); openRecite(); });
    bx.addEventListener('click', () => { delete favVerses[`${s}:${a}`]; store.set('favVerses', favVerses); renderFavs(); });
    ul.appendChild(li);
  }
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
  rec.firstSaid = {};
  rec.letterFaults = {};
  rec.posAt = {};
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
  const sw = letterSwap(norm(heardRaw), norm(expected));
  if (sw) return `lettre « ${bidi(sw[0])} » au lieu de « ${bidi(sw[1])} »`;
  const miss = fixSpots(expected, heardRaw).filter((s) => s.letter).map((s) => [...laboSlots(expected)[s.k].raw][0]);
  if (miss.length && norm(heardRaw).length < norm(expected).length) return `lettre « ${bidi(miss.join(' '))} » non entendue`;
  if (miss.length === 1) { // autre lettre (« وَعَقِيمُوا » pour « وَأَقِيمُوا »)
    const b = laboSlots(heardRaw), used = new Set(alignSlots(laboSlots(expected), b));
    const got = b.find((s, j) => norm(s.raw) && !used.has(j));
    if (got) return `lettre « ${bidi([...got.raw][0])} » au lieu de « ${bidi(miss[0])} »`;
  }
  const d = vowelDiff(expected, heardRaw, true) || vowelDiff(expected, heardRaw, false);
  return d ? `lettre « ${bidi(d.letter)} » : ${vowelName(d.got)} au lieu de ${vowelName(d.exp)}` : '';
}

// Endroits fautifs du mot attendu, pour les montrer en rouge : lettres non entendues ou remplacées
// ({ k, letter: true }, k = indice de la lettre dans laboSlots), sinon la voyelle fausse ({ k })
function fixSpots(expected, heardRaw) {
  const a = laboSlots(expected), b = laboSlots(heardRaw);
  const pair = alignSlots(a, b);
  const letters = a.map((s, k) => k).filter((k) => norm(a[k].raw) && pair[k] === undefined);
  if (letters.length) return letters.length <= 2 ? letters.map((k) => ({ k, letter: true })) : [];
  const d = vowelDiff(expected, heardRaw, true) || vowelDiff(expected, heardRaw, false);
  return d ? [{ k: d.k }] : [];
}

// Une seule lettre du mot attendu dite comme une autre (« بِالسَّبْرِ » pour « بِالصَّبْرِ ») :
// { exp: 'ص', got: 'س' } (null sinon, ou si les deux lettres ne diffèrent que par l'écriture de la hamza)
function letterFault(expected, heardRaw) {
  const a = laboSlots(expected), b = laboSlots(heardRaw);
  const pair = alignSlots(a, b), used = new Set(pair);
  const ea = a.filter((s, k) => norm(s.raw) && pair[k] === undefined);
  const hb = b.filter((s, j) => norm(s.raw) && !used.has(j));
  if (ea.length !== 1 || hb.length !== 1) return null;
  const exp = norm(ea[0].raw), got = norm(hb[0].raw);
  return exp && got && exp !== got ? { exp, got } : null;
}

// Comment prononcer la lettre attendue (articulation, makhraj et sifat), pour les lettres que l'on
// confond le plus souvent
const LETTER_TIPS = {
  'ص': 'lettre emphatique (tafkhim) : comme س, mais le fond de la langue levé vers le palais, le son plus plein et plus grave',
  'ض': 'lettre emphatique : le bord de la langue contre les molaires du haut, le son plein (pas un د)',
  'ط': 'lettre emphatique (tafkhim) et qalqala : comme ت, mais le fond de la langue levé, le son plus plein',
  'ظ': 'lettre emphatique : le bout de la langue entre les dents, comme ذ, avec le fond de la langue levé',
  'ذ': 'le bout de la langue entre les dents, sans emphase (pas un ز)',
  'ث': 'le bout de la langue entre les dents, souffle léger (pas un س)',
  'ق': 'du fond de la langue contre la luette, plus profond que ك, avec qalqala',
  'ح': 'du milieu de la gorge, souffle serré (pas un ه)',
  'ه': 'du fond de la gorge, souffle léger (pas un ح)',
  'ع': 'du milieu de la gorge, voisé (pas un ا ni un ء)',
  'ل': 'le bout de la langue contre le palais derrière les dents, bien net (pas un ن)',
  'ر': 'le bout de la langue contre le palais, une seule frappe (pas un ل)',
  'س': 'sifflante légère, sans emphase (pas un ص)',
  'ز': 'sifflante sonore, la langue derrière les dents (pas un ذ ni un ظ)',
};

// Bilan des lettres fautives : pour chaque lettre attendue, nombre de mots où elle a été dite comme
// une autre, sur les mots récités qui la contiennent ; gardé d'une récitation à l'autre (localStorage
// « letters ») pour suivre les progrès
function letterReport(marks, count = true) {
  const faults = {};
  for (const [i, f] of Object.entries(rec.letterFaults)) {
    (faults[f.exp] ||= { n: 0, got: {}, words: [] }).n++;
    faults[f.exp].got[f.got] = (faults[f.exp].got[f.got] || 0) + 1;
    faults[f.exp].words.push(+i);
  }
  const stats = store.get('letters', {});
  const today = new Date().toISOString().slice(0, 10);
  const out = Object.entries(faults).map(([exp, f]) => {
    // mots récités contenant la lettre, et ceux où elle a été bien dite (mot juste du premier coup)
    const withL = rec.words.slice(0, marks.length).filter((w) => w.norm.includes(exp)).length; // mots déjà récités
    const okL = rec.words.filter((w, i) => w.norm.includes(exp) && marks[i] === 'ok').length;
    const s = (stats[exp] ||= { faults: 0, ok: 0, sessions: [] });
    const got = Object.entries(f.got).sort((x, y) => y[1] - x[1])[0][0];
    if (count && rec.letterCounted !== rec.firstErr) { s.faults += f.n; s.ok += okL; s.sessions = [...s.sessions, today].slice(-20); s.mainGot = got; }
    return { exp, got, n: f.n, withL, okL, words: f.words, tip: LETTER_TIPS[exp] || '' };
  });
  if (!count) return out.sort((x, y) => y.n - x.n); // bilan partiel (micro arrêté) : compté à la vraie fin
  rec.letterCounted = rec.firstErr; // une seule fois par récitation (finish peut être rappelé)
  store.set('letters', stats);
  return out.sort((x, y) => y.n - x.n);
}

// Le mot attendu, avec la lettre fautive en rouge (voyelle fausse : la lettre qui la porte, avec sa
// voyelle ; Chrome ne sait pas colorer un signe de voyelle seul, il reste de la couleur du mot)
function markedWord(expected, heardRaw) {
  const el = document.createElement('span');
  el.className = 'ar ok'; el.dir = 'rtl'; el.lang = 'ar';
  const spots = new Set(fixSpots(expected, heardRaw).map((s) => s.k));
  laboSlots(expected).forEach((s, k) => {
    if (!spots.has(k)) { el.append(s.raw); return; }
    const red = document.createElement('span');
    red.className = 'spot'; red.textContent = s.raw;
    el.append(red);
  });
  return el;
}

// Lettres proches que l'on confond en récitant : une seule lettre changée de la paire, le reste
// identique → [lettre dite, lettre attendue] (null sinon)
const CONFUSABLE = new Set(['صس', 'طت', 'ضد', 'ضظ', 'ظذ', 'ظز', 'ذز', 'قك', 'حه', 'ثس']);
function letterSwap(heard, expected) {
  if (heard.length !== expected.length) return null;
  let d = null;
  for (let k = 0; k < heard.length; k++) if (heard[k] !== expected[k]) { if (d) return null; d = [heard[k], expected[k]]; }
  return d && (CONFUSABLE.has(d[0] + d[1]) || CONFUSABLE.has(d[1] + d[0])) ? d : null;
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
    if (hv !== a[k].v) return { letter: [...a[k].raw][0], exp: a[k].v, got: hv, k };
  }
  return null;
}

function checkVowels(st, j, heardRaw, pause = false) {
  if (!vowelCheck() || st.marks[j] === 'bad') return;
  const E = rec.words, endOfAyah = j + 1 >= E.length || E[j + 1].ayah !== E[j].ayah || E[j + 1].s !== E[j].s;
  if (vowelError(E[j].text, heardRaw, endOfAyah || pause)) { st.marks[j] = 'bad'; st.vow[j] = heardRaw; }
}

const BASMALA_WORDS = ['بسم', 'الله', 'الرحمن', 'الرحيم'];

// Fait avancer l'état avec les mots entendus (raw : les mêmes, tels qu'écrits, avec voyelles).
// stops : indices des mots entendus suivis d'une pause (voyelle finale non exigée).
// open : texte provisoire du serveur (morceau en cours), son dernier mot est peut-être coupé
// lettres isolées du début de 29 sourates (يس، الم، حم، كهيعص…) : écrites en lettres, récitées par
// leur nom ; « يَا سِين » était refusé pour « يس » à chaque essai (06/11/2026)
const LETTER_NAMES = { ا: 'الف', ل: 'لام', م: 'ميم', ص: 'صاد', ر: 'را', ك: 'كاف', ه: 'ها', ي: 'يا', ع: 'عين', ط: 'طا', س: 'سين', ح: 'حا', ق: 'قاف', ن: 'نون' };
const OPENING_LETTERS = new Set([2, 3, 7, 10, 11, 12, 13, 14, 15, 19, 20, 26, 27, 28, 29, 30, 31, 32, 36, 38, 40, 41, 42, 43, 44, 45, 46, 50, 68]);
function spokenOf(e) {
  if (e.spoken === undefined) {
    const opening = e.k === 0 && ((e.ayah === 1 && OPENING_LETTERS.has(e.s)) || (e.s === 42 && e.ayah === 2));
    e.spoken = opening && [...e.norm].every((c) => LETTER_NAMES[c]) ? [...e.norm].map((c) => LETTER_NAMES[c]).join('') : null;
  }
  return e.spoken;
}

function align(st, heard, raw = [], stops = new Set(), open = false) {
  const E = rec.words, N = E.length;
  // un mot du texte qui vient juste après (8 mots) : lu en avance ou mal placé par le modèle,
  // pas un mot remplacé (« قَلِيلًا » entendu au début d'une reprise à « وَلَا تَشْتَرُوا », 30/10/2026)
  const soon = (x, p) => E.slice(p, p + 8).some((e) => e.norm === x);
  for (let i = 0; i < heard.length && st.pos < N; i++) {
    const w = heard[i];
    const p = st.pos;
    // lettres du début de sourate (« يس » dit « يا سين ») : comparées à leur nom, sur 1 à 4 morceaux
    const sp = spokenOf(E[p]);
    if (sp && w !== E[p].norm) {
      let best = null;
      for (let k = 1; k <= 4 && i + k <= heard.length; k++) {
        const d = lev(heard.slice(i, i + k).join(''), sp);
        if (d <= Math.max(1, Math.round(sp.length * 0.3)) && (!best || d < best.d)) best = { k, d };
      }
      if (best) { advanceOk(st, p); i += best.k - 1; continue; }
      // nom collé au mot suivant (« يَا سينقرْآنِ ») : la fin du dernier morceau est ce mot suivant
      const ne = p + 1 < E.length ? E[p + 1].norm : '';
      for (let k = 1; !best && ne && k <= 4 && i + k <= heard.length; k++) {
        const j = heard.slice(i, i + k).join(''), lastLen = heard[i + k - 1].length;
        for (let cut = Math.max(j.length - lastLen + 1, sp.length - 1); cut <= sp.length + 1 && cut < j.length; cut++) {
          const rem = j.slice(cut);
          if (rem.length >= 2 && lev(j.slice(0, cut), sp) <= Math.max(1, Math.round(sp.length * 0.3)) && (same(rem, ne) || ne.endsWith(rem))) { best = { k, rem }; break; }
        }
      }
      // (niveau souple : début du mot suivant avalé dans la liaison, « يس وَالْقُرْآنِ » entendu « يَا سينقرْآنِ »)
      if (best && best.rem !== ne && !same(best.rem, ne) && LEVELS[rec.level].lenient) { markOk(st, p); advanceOk(st, p + 1); i += best.k - 1; continue; }
      if (best) { advanceOk(st, p); const t = i + best.k - 1;
        heard = [...heard.slice(0, t), best.rem, ...heard.slice(t + 1)]; raw = [...raw.slice(0, t), best.rem, ...raw.slice(t + 1)];
        i = t - 1; continue;
      }
      // texte provisoire : début du nom seulement (« يا »), la suite arrive
      const rest = heard.slice(i).join('');
      if (open && rest.length < sp.length && lev(rest, sp.slice(0, rest.length)) <= 1) break;
    }
    // lettre isolée (bruit, fin du son d'un rappel) : ignorée, sauf si c'est le mot attendu (ق، ص، ن)
    // (ou « مِنْ » assimilé : « م » devant « رَبِّهِمْ »)
    if (w.length <= 1 && E[p].norm.length > 1 && !nunAlone(w, p)) continue;
    // basmala récitée avant une sourate (absente du texte, sauf dans Al-Fatiha) : ignorée, ce ne sont
    // pas des mots en trop (« قُلْ » de 112:1 compté faux après la basmala, 31/10/2026)
    if (E[p].ayah === 1 && E[p].k === 0 && w !== E[p].norm && BASMALA_WORDS.some((b) => same(w, b))) continue;
    // après un signal, on doit revenir au mot faux ; si l'on a continué plus loin (signal pas vu), ces
    // mots ne sont pas des fautes : ignorés en attendant le mot faux (sinon tout le reste passait en
    // rouge, de « النَّصْرُ » à la fin de la récitation, 01/11/2026). Un nouvel essai du mot (même
    // raté) n'est pas ignoré.
    if (st.back !== p) st.back = -1;
    else if (w !== E[p].norm && !same(w, E[p].norm) && E.slice(p + 1, p + 15).some((e) => e.norm === w || (w.length >= 3 && same(w, e.norm)))) {
      st.ignored++;
      continue;
    }
    if (w === E[p].norm) {
      // serveur : un autre vrai mot du Coran dit juste avant à sa place (« وَإِيَّايَ فَارْهَبُونِ » puis
      // « وَإِيَّايَ فَاتَّقُونِ ») : se reprendre soi-même n'efface pas l'erreur, comme devant un cheikh
      const wrong = rec.engine === 'server' ? st.pending.filter((x) => x.length >= 3 && isQuranWord(x) && lev(x, w) >= 2 && !soon(x, p)) : [];
      advanceOk(st, p);
      if (wrong.length) { st.marks[p] = 'bad'; st.heard[p] = wrong; } else checkVowels(st, p, raw[i], stops.has(i));
      if (alignPron?.[i]) st.pron[p] = alignPron[i];
      continue;
    }
    if (isLearned(w, E[p].norm)) { advanceOk(st, p); continue; }
    // ة à l'arrêt : elle se dit « h » léger, que le modèle n'écrit souvent pas (« التَّوْرَىٰ » pour
    // « التَّوْرَاةُ » devant ۗ, refusé 3 fois le 02/11/2026) ; ى suscrit final = ā
    if ((stops.has(i) || i === heard.length - 1) && /ة[^ء-ي]*$/.test(E[p].text) && w.replace(/ي$/, 'ا') === E[p].norm.slice(0, -1)) {
      advanceOk(st, p);
      if (alignPron?.[i]) st.pron[p] = alignPron[i];
      continue;
    }
    // un mot exact un peu plus loin passe avant un mot seulement ressemblant ici
    // (ex. « لم يولد » ne doit pas valider « يلد »)
    let exact = 0;
    for (let k = 1; k <= 3 && p + k < N; k++) {
      if (E[p + k].norm.length >= 3 && w === E[p + k].norm) { exact = k; break; }
    }
    if (exact) {
      skipped(st, p, exact); advanceOk(st, p + exact); checkVowels(st, p + exact, raw[i], stops.has(i));
      if (alignPron?.[i]) st.pron[p + exact] = alignPron[i];
      continue;
    }
    // deux mots attendus entendus collés (« أَيْنَمَا » pour « أَيْنَ مَا ») : avant la simple
    // ressemblance, sinon « أينما » passerait pour « أين » et « ما » pour un oubli
    const both = p + 1 < N ? E[p].norm + E[p + 1].norm : null;
    if (both && same(w, both) && lev(w, both) < lev(w, E[p].norm) && startsLike(w, E[p].norm)) { markOk(st, p); advanceOk(st, p + 1); continue; }
    // serveur Hifz (texte fiable) : un autre vrai mot du Coran (« فَارْهَبُونِ » pour « فَاتَّقُونِ »,
    // versets semblables) n'est pas une transcription approximative, la ressemblance ne suffit pas ;
    // et une lettre proche (« بِالسَّبْرِ » pour « بِالصَّبْرِ ») est une faute de prononciation
    const server = rec.engine === 'server';
    // mot attendu coupé au mauvais endroit par le modèle (05/11/2026, 18:12 et 18:15) : « احز » + « بين »
    // pour « الْحِزْبَيْنِ » (« بين », vrai mot du Coran, passait pour un mot en trop), ou la fin du mot
    // collée au suivant : « لَوْ » + « لَيَأْتُونَ » pour « لَوْلَا يَأْتُونَ »
    if (server && i + 1 < heard.length && p + 1 < N) {
      const nx = heard[i + 1], ne = E[p + 1].norm, isNext = (x) => x === ne || same(x, ne);
      // (pas deux mots qui sont exactement des mots qui suivent : « لَمْ تُنْذِرْهُمْ » n'est pas un
      // « أَأَنْذَرْتَهُمْ » coupé, c'est ce mot oublié, test du 05/11/2026)
      const ahead = (x) => E.slice(p + 1, p + 5).some((e) => e.norm === x);
      if (!isNext(nx) && !ahead(w) && !ahead(nx) && same(w + nx, E[p].norm) && lev(w + nx, E[p].norm) < lev(w, E[p].norm)) { advanceOk(st, p); i++; continue; }
      const k = [1, 2].find((k) => nx.length > k + 1 && E[p].norm.length >= 3 && lev(w + nx.slice(0, k), E[p].norm) <= 1 && isNext(nx.slice(k)));
      if (k) { markOk(st, p); advanceOk(st, p + 1); i++; continue; }
    }
    // (sauf mot coupé par le serveur : « وان » + « تم » pour « وَأَنْتُمْ »)
    const cutWord = E[p].norm.startsWith(w) || w.startsWith(E[p].norm);
    if (!(server && !cutWord && isQuranWord(w) && lev(w, E[p].norm) >= 2) && same(w, E[p].norm)) {
      advanceOk(st, p);
      if (server && !LEVELS[rec.level].lenient && letterSwap(w, E[p].norm)) { st.marks[p] = 'bad'; st.vow[p] = raw[i] || w; }
      continue;
    }
    // serveur : le « و » / « ف » du premier mot d'un morceau (après une pause) est souvent perdu par le
    // modèle (« لَا تَلْبِسُوا » pour « وَلَا تَلْبِسُوا ») : accepté en niveau souple seulement (2 faux rappels
    // le 30/10/2026) ; en niveau strict, le mot est à reprendre
    if (server && LEVELS[rec.level].lenient && (i === 0 || stops.has(i - 1)) && w.length >= 2 && (E[p].norm === 'و' + w || E[p].norm === 'ف' + w)) {
      advanceOk(st, p);
      continue;
    }
    // liaison : « مِنَ اللَّهِ » entendu « مِنَلَّهِ », ou « اللَّهِ » entendu « لَّهِ »
    if (waslJoined(w, p)) { markOk(st, p); advanceOk(st, p + 1); continue; }
    // reprise au mot d'avant, collé au mot attendu (« تُنَزَّلَلتَّوْرَىٰةِ » en revenant sur التوراة)
    if (p > 0 && waslJoined(w, p - 1)) { advanceOk(st, p); continue; }
    if (waslAlone(w, p)) { advanceOk(st, p); continue; }
    if (tanwinNunAlone(w, p)) { advanceOk(st, p); continue; }
    // إدغام / إقلاب : « مِنْ رَبِّهِمْ » entendu « مِرَّبِّهِمْ », ou « مِنْ » entendu « مِ »
    if (nunJoined(w, p)) { markOk(st, p); advanceOk(st, p + 1); continue; }
    if (nunAlone(w, p)) { advanceOk(st, p); continue; }
    // texte provisoire : son dernier mot est souvent coupé (« بِآيَة » pour « بِآيَاتِي ») ; il sera jugé
    // quand le morceau sera terminé (un rappel était déclenché sur ce bout de mot, 30/10/2026)
    if (open && i === heard.length - 1) break;
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
    // « وَاللَّهُ » pour « فَإِنَّ اللَّهَ » (3:32, 05/11/2026) : le و / ف collé au mot suivant a pris la place
    // du mot sauté ; c'est un mot remplacé (erreur de mémoire), pas un mot que le micro n'a pas capté
    if (skip === 1 && server && /^[وف]/.test(w) && w.slice(1) === E[p + 1].norm && !E[p + 1].norm.startsWith(w[0])) {
      st.marks[p] = 'bad'; st.heard[p] = [w]; st.extra = 0; st.pending = []; st.grace = 0;
      advanceOk(st, p + 1);
      continue;
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
    // (ni le mot que l'application vient de prononcer, capté par le micro : rec.echo)
    // (ni un mot qui vient juste après dans le texte : « قَلِيلًا » au début d'une reprise à « وَلَا تَشْتَرُوا »)
    if (st.grace > 0) { st.grace--; if (w.length < 3 || !isQuranWord(w) || w === rec.echo || soon(w, p)) continue; }
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
    // serveur, niveaux normal et souple : des mots en trop dont aucun n'est un mot du Coran (« فلعتق الري »,
    // « نحليذ برنحهلياذ ») sont du bruit (télé, voix à côté) ou des mots collés mal compris, pas une
    // erreur : 9 faux rappels sur 36 le 04/11/2026. Ignorés si le bon mot attendu suit.
    // (sauf un mot à une lettre près d'un mot du Coran : un vrai mot en trop collé ou mal coupé, test du 05/11/2026)
    if (server && rec.level >= 2 && !isQuranWord(w) && !nearQuranWord(w) && st.pending.every((x) => !isQuranWord(x)) && i + 1 < heard.length) {
      const nx = heard[i + 1];
      if (nx === E[p].norm || isLearned(nx, E[p].norm) || same(nx, E[p].norm)) { st.pending = []; st.extra = 0; continue; }
    }
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
    // serveur : un autre vrai mot du Coran suivi d'une pause (« وَإِيَّايَ فَارْهَبُونِ » en fin de 2:41)
    // est un mot remplacé : erreur tout de suite, sans attendre d'autres mots inconnus
    if (server && stops.has(i) && !st.pending.length && w.length >= 3 && isQuranWord(w) && lev(w, E[p].norm) >= 2 && !soon(w, p)) {
      st.marks[p] = 'bad';
      st.heard[p] = [w];
      st.pos = p + 1;
      st.extra = 0;
      st.grace = 0;
      continue;
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

// ---------- Découpage du texte entendu selon le texte attendu (05/11/2026) ----------
// Le modèle place lui-même les espaces entre les mots et se trompe parfois : « احز بين » pour
// « الْحِزْبَيْنِ », « لَوْ لَيَأْتُونَ » pour « لَوْلَا يَأْتُونَ ». Les lettres entendues (sans les espaces)
// sont alignées lettre à lettre sur les mots attendus, puis recoupées à la fin de chaque mot attendu,
// seulement là où le résultat ressemble bien aux mots attendus ; la comparaison mot à mot (align)
// juge ensuite chaque mot comme avant (oubli, autre mot, mot en trop, voyelles…).
// Réglage ⚙ « Découpage selon le texte » (activé par défaut) : le désactiver revient à l'ancien comportement.
let recutOn = store.get('recut', true);

// Lettres d'un mot tel qu'écrit : la lettre normalisée k commence à cut[k] dans le texte (avec ses
// signes) ; null si la découpe lettre par lettre ne redonne pas norm(mot) (mot alors gardé entier)
function letterCuts(raw) {
  const s = raw.normalize('NFC'), cut = [];
  let n = '';
  for (let x = 0; x < s.length; x++) {
    if (!/[ء-يٱ]/.test(s[x]) || s[x] === 'ـ') continue; // signes (voyelles, marques du mushaf) : avec leur lettre
    const c = norm(s[x]);
    for (let k = 0; k < c.length; k++) cut.push(x);
    n += c;
  }
  return n === norm(raw) ? { s, cut } : null;
}

function recut(heard, raw, stops, pron, p0) {
  const E = rec.words, keep = { heard, raw, stops, pron, changed: 0 };
  if (!heard.length || p0 >= E.length) return keep;
  // lettres entendues : jeton d'origine et rang dans le jeton
  const H = [], cuts = raw.map(letterCuts);
  heard.forEach((w, t) => { for (let k = 0; k < w.length; k++) H.push({ c: w[k], t, k }); });
  // lettres attendues, sur une fenêtre assez large pour tout ce qui a été entendu
  const X = [];
  for (let j = p0; j < E.length && X.length < H.length * 2 + 60; j++) for (const c of spokenOf(E[j]) || E[j].norm) X.push({ c, j });
  const n = H.length, m = X.length;
  if ((n + 1) * (m + 1) > 8e6) return keep;
  // alignement : chaque lettre en plus, en moins ou différente coûte 1 ; la fin du texte attendu est
  // libre (on ne sait pas jusqu'où la récitation est allée). Calculé dans une bande autour de la
  // diagonale (jusqu'à 400 lettres entendues en plus : versets repris, bruit ; 150 attendues en moins) :
  // 10 fois plus rapide sur une longue récitation
  const BAND_H = 400, BAND_E = 150, INF = 1e9;
  const back = new Uint8Array((n + 1) * (m + 1)); // 1 diagonale, 2 lettre entendue en plus, 3 lettre attendue en moins
  let prev = new Int32Array(m + 1).fill(INF), cur = new Int32Array(m + 1).fill(INF);
  prev[0] = 0;
  for (let j = 1; j <= Math.min(m, BAND_E); j++) { prev[j] = j; back[j] = 3; }
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(1, i - BAND_H), hi = Math.min(m, i + BAND_E);
    cur.fill(INF);
    if (lo === 1) { cur[0] = i; back[i * (m + 1)] = 2; }
    const hc = H[i - 1].c;
    for (let j = lo; j <= hi; j++) {
      let v = prev[j - 1] + (hc === X[j - 1].c ? 0 : 1), b = 1;
      if (prev[j] + 1 < v) { v = prev[j] + 1; b = 2; }
      if (cur[j - 1] + 1 < v) { v = cur[j - 1] + 1; b = 3; }
      cur[j] = v; back[i * (m + 1) + j] = b;
    }
    [prev, cur] = [cur, prev];
  }
  let jEnd = 0;
  for (let j = 1; j <= m; j++) if (prev[j] < prev[jEnd]) jEnd = j;
  if (prev[jEnd] >= INF) return keep; // hors de la bande : récitation trop éloignée du texte attendu
  // mot attendu de chaque lettre entendue (-1 : lettre en plus)
  const lab = new Array(n).fill(-1);
  for (let i = n, j = jEnd; i > 0 || j > 0;) {
    const b = back[i * (m + 1) + j];
    if (b === 1 && i > 0 && j > 0) { lab[i - 1] = X[j - 1].j; i--; j--; } else if ((b === 2 || j === 0) && i > 0) i--; else j--;
  }
  // lettre en plus au milieu d'un mot attendu (même jeton, même mot de part et d'autre) : à ce mot
  for (let i = 0; i < n; i++) {
    if (lab[i] >= 0) continue;
    let a = i - 1, z = i + 1;
    while (z < n && lab[z] < 0) z++;
    if (a >= 0 && z < n && lab[a] === lab[z] && H[a].t === H[z].t) for (let x = i; x < z; x++) lab[x] = lab[a];
  }
  // découpe proposée : une coupure entre deux lettres de mots attendus différents, ou là où le modèle
  // en mettait une à côté d'une lettre en plus
  const groups = [];
  for (let i = 0; i < n; i++) {
    const g = groups[groups.length - 1];
    const join = g && (lab[i] >= 0 ? lab[i] === g.j : g.j < 0 && H[i].t === H[i - 1].t);
    if (join) g.end = i + 1; else groups.push({ j: lab[i], start: i, end: i + 1 });
  }
  // zones : jetons d'origine reliés par un changement de découpe ; une zone n'est recoupée que si
  // chaque nouveau morceau ressemble à son mot attendu, et qu'aucun jeton d'origine n'y était déjà
  // exactement un des mots attendus (ou une écriture retenue pour lui)
  const tokOf = (g) => [H[g.start].t, H[g.end - 1].t];
  const zones = [];
  for (const g of groups) {
    const [a, z] = tokOf(g), last = zones[zones.length - 1];
    if (last && a <= last.z) { last.z = Math.max(last.z, z); last.groups.push(g); } else zones.push({ a, z, groups: [g] });
  }
  const outH = [], outR = [], outS = new Set(), outP = [];
  let changed = 0;
  const pushOrig = (t) => { outH.push(heard[t]); outR.push(raw[t]); outP.push(pron ? pron[t] : null); if (stops.has(t)) outS.add(outH.length - 1); };
  for (const zn of zones) {
    const piece = (g) => H.slice(g.start, g.end).map((h) => h.c).join('');
    const exactly = zn.groups.length === zn.z - zn.a + 1 && zn.groups.every((g, q) => H[g.start].t === zn.a + q && H[g.start].k === 0 && g.end - g.start === heard[zn.a + q].length);
    const words = new Set(zn.groups.map((g) => g.j));
    const ok = !exactly && zn.groups.every((g) => g.j >= 0 && same(piece(g), spokenOf(E[g.j]) || E[g.j].norm))
      && zn.groups.every((g) => cuts[H[g.start].t] && cuts[H[g.end - 1].t])
      && !Array.from({ length: zn.z - zn.a + 1 }, (_, q) => heard[zn.a + q]).some((w) => [...words].some((j) => w === E[j].norm || isLearned(w, E[j].norm)));
    if (!ok) { for (let t = zn.a; t <= zn.z; t++) pushOrig(t); continue; }
    changed++;
    for (const g of zn.groups) {
      // texte écrit (avec voyelles) du morceau : bouts des jetons d'origine recollés
      let r = '';
      for (let i = g.start; i < g.end;) {
        const t = H[i].t, cu = cuts[t];
        let e = i; while (e < g.end && H[e].t === t) e++;
        const from = H[i].k === 0 ? 0 : cu.cut[H[i].k], to = H[e - 1].k + 1 < cu.cut.length ? cu.cut[H[e - 1].k + 1] : cu.s.length;
        r += cu.s.slice(from, to);
        i = e;
      }
      const lt = H[g.end - 1].t;
      outH.push(piece(g)); outR.push(r); outP.push(null);
      if (stops.has(lt) && H[g.end - 1].k === heard[lt].length - 1) outS.add(outH.length - 1);
    }
  }
  return changed ? { heard: outH, raw: outR, stops: outS, pron: pron ? outP : null, changed } : keep;
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
  }
  // le cadre indique la page (sourate, juz) et le quart de hizb du mot attendu (en livre, la page
  // est tournée par renderBook : seul le quart change ici)
  const w = rec.words[Math.min(st.pos, rec.words.length - 1)];
  const p = w && QURAN[w.s - 1].p[w.ayah - 1], q = w && QURAN[w.s - 1].q[w.ayah - 1];
  if (p && (rec.book ? p === framePage.recite && q !== frameQuarter.recite : p !== framePage.recite || q !== frameQuarter.recite)) updateFrame('recite', p, q);
  const t = validateTarget();
  // « off » plutôt que disabled : un bouton désactivé ne reçoit plus le doigt pour être déplacé
  $('#fab-word').textContent = t >= 0 ? rec.words[t].text : '';
  $('#btn-validate').classList.toggle('off', t < 0);
  const f = flagTarget();
  $('#flag-word').textContent = f >= 0 ? rec.words[f].text : '';
  $('#btn-flag').classList.toggle('off', f < 0);
  placeSoon();
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
  // moment où chaque mot a été reconnu la première fois (délai jusqu'au rappel, pour le diagnostic)
  for (let p = 0; p < st.pos; p++) rec.posAt[p] ??= Date.now();
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

// « Tic » très court (0,04 s, 1 500 Hz) : joué sans couper le micro ; trop bref pour gêner la
// reprise, le serveur n'en tire au plus qu'une lettre isolée (ignorée)
const TICK = (() => {
  const rate = 16000, n = rate * 0.04, buf = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, s) => [...s].forEach((c, k) => buf.setUint8(o + k, c.charCodeAt(0)));
  str(0, 'RIFF'); buf.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true); buf.setUint16(22, 1, true); buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  str(36, 'data'); buf.setUint32(40, n * 2, true);
  for (let k = 0; k < n; k++) {
    const fade = Math.min(1, k / 48, (n - k) / 48);
    buf.setInt16(44 + k * 2, Math.sin(2 * Math.PI * 1500 * k / rate) * 12000 * fade, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
})();

// Bip de montre électronique (05/11/2026) : deux « bip » de 25 ms à 4 kHz, 45 ms d'écart (0,1 s en
// tout). Plus aigu que la voix (le modèle n'y entend pas de lettre) et très bref ; en plus, ce moment
// est remplacé par du silence dans le son envoyé au serveur (micMute, remote.js).
const WATCH_MS = 95;
const WATCH = (() => {
  const rate = 44100, n = Math.round(rate * WATCH_MS / 1000), buf = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, s) => [...s].forEach((c, k) => buf.setUint8(o + k, c.charCodeAt(0)));
  str(0, 'RIFF'); buf.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true); buf.setUint16(22, 1, true); buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  str(36, 'data'); buf.setUint32(40, n * 2, true);
  const on = (t) => (t < 0.025 ? t : t >= 0.07 ? t - 0.07 : -1); // temps dans un des deux bips, sinon -1
  for (let k = 0; k < n; k++) {
    const t = k / rate, u = on(t);
    if (u < 0 || u >= 0.025) continue;
    const fade = Math.min(1, u / 0.002, (0.025 - u) / 0.002);
    // onde presque carrée (son « électronique » des montres), adoucie pour ne pas saturer
    const s = Math.sin(2 * Math.PI * 4000 * t), sq = Math.sign(s) * Math.min(1, Math.abs(s) * 3);
    buf.setInt16(44 + k * 2, sq * 7000 * fade, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
})();

// Signal sans coupure du micro : écran rouge qui clignote 2 fois + vibration (Android, mais le S21 ne
// vibre pas pendant que le micro écoute, 01/11/2026) + bip de montre ou « tic » si choisi. On redit le
// mot dès le signal, alors qu'avec le bip le début du mot, dit pendant le bip, était perdu (01/11/2026).
function flashSignal() {
  const v = views.recite;
  v.classList.remove('flash');
  void v.offsetWidth; // relance l'animation
  v.classList.add('flash');
  try { navigator.vibrate?.([120, 80, 120]); } catch { /* pas de vibreur */ }
  const sound = { tick: [TICK, 40], watch: [WATCH, WATCH_MS] }[rec.signal];
  if (sound && !sayAudio) {
    sayEl.onended = sayEl.onerror = null;
    sayEl.src = sound[0];
    // le son du signal capté par le micro n'est pas envoyé au serveur (silence à la place)
    // (+ 300 ms : retard du haut-parleur et du micro sur Android ; on met plus de temps à reprendre le mot)
    sayEl.onplaying = () => { sayEl.onplaying = null; window.micMute?.(Date.now() - 30, Date.now() + sound[1] + 300); };
    sayEl.play().catch(() => { sayEl.onplaying = null; });
  }
}

function playBeep(done) {
  sayAudio = sayEl;
  sayEl.onended = sayEl.onerror = () => { sayAudio = null; done(); };
  sayEl.src = BEEP;
  sayEl.play().catch(() => { sayAudio = null; done(); });
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
// serveur Hifz : texte provisoire fiable, 1 mot suffit (avec 2, l'arrêt venait 2 à 5 mots trop tard, 04/11/2026)
const REPLAY_CONFIRM_SERVER = 1;

// Après un rappel, pas de nouveau rappel avant REPLAY_SETTLE mots justes : le temps de se remettre
// dans la récitation (les erreurs restent marquées, sans interrompre).
const REPLAY_SETTLE = 3;

// interruptions au plus pour un même mot : les bips puis la prononciation (2 fois s'il n'y a pas de bip)
const repriseMax = () => Math.max(2, rec.beeps + 1);

function checkReplay(st, final) {
  if (!rec.replay || !rec.listening || rec.pausing) return false;
  // juste après un rappel, seuls les mots faux interrompent (un mot faux à la reprise, « وَاللَّهُ » pour
  // « فَإِنَّ اللَّهَ », passait sans rien dire, 05/11/2026) ; un mot « non entendu » attend REPLAY_SETTLE mots
  const settling = rec.lastReplayAt >= 0 && st.pos < rec.lastReplayAt + REPLAY_SETTLE;
  // serveur : un mot qui manque dans le texte provisoire n'interrompt pas tout de suite, le modèle y
  // avale souvent les petits mots (22 rappels injustes sur 64 le 05/11/2026) : on attend le texte
  // définitif du morceau (à la pause, ou 15 s au plus). S'il y manque encore, c'est un vrai oubli :
  // rappel, même s'il est plus loin que REPLAY_WINDOW (un mot manquant n'est jamais accepté).
  const server = rec.engine === 'server';
  const from = Math.max(0, st.pos - REPLAY_WINDOW), lo = server && final ? Math.max(0, Math.min(from, rec.lastFinalPos ?? from)) : from;
  if (server && final) rec.lastFinalPos = st.pos;
  for (let i = lo; i < st.pos; i++) {
    const m = markOf(st, i);
    if ((m !== 'bad' && m !== 'unsure') || (rec.retries[i] || 0) >= repriseMax() || rec.noReplay.has(i)) continue;
    // (de même pour une voyelle fausse : le texte provisoire se trompait de voyelle et le définitif
    // avait la bonne, 6 rappels injustes sur 19 le 05/11/2026 à 23h33)
    const missing = server && (errorKind(st, i) === 'forgot' || !!st.vow[i]);
    if (i < from && !missing) continue;
    if (missing && !final) continue;
    if (settling && (m !== 'bad' || i < rec.lastReplayAt)) continue;
    if (!final && st.pos - 1 - i < (server ? REPLAY_CONFIRM_SERVER : REPLAY_CONFIRM)) continue; // provisoire : pas encore assez sûr
    replayAt(i, final);
    return true;
  }
  return false;
}

function replayAt(i, final = true) {
  rec.lastReplayAt = i;
  rec.pausing = true;
  rec.retries[i] = (rec.retries[i] || 0) + 1;
  rec.firstErr[i] ||= errorKind(rec.shown, i); // pour le bilan, même si le mot est retrouvé ensuite
  // chaque rappel part dans le journal du serveur (diagnostic) : mot, raison, retard (04/11/2026)
  if (rec.engine === 'server') {
    const w = rec.words[i], s = rec.shown;
    sendFault({
      ref: `${w.s}:${w.ayah}`, word: w.text, kind: errorKind(s, i), heard: (s.heard[i] || []).join(' '),
      vow: String(s.vow[i] || ''), ins: [].concat(s.ins[i] || []).join(' '), final, ahead: s.pos - 1 - i, level: rec.level,
      retry: rec.retries[i], lag: rec.posAt[i] != null ? Date.now() - rec.posAt[i] : -1,
    });
  }
  const r = rec.recognition;
  rec.recognition = null;
  if (r) { try { r.abort(); } catch { /* déjà arrêté */ } }

  // mot entendu presque juste (« لَا » pour « وَلَا ») : la lettre manquante ou remplacée est montrée
  const e = rec.words[i].norm;
  const close = !rec.shown.vow[i] && !rec.shown.ins[i] && (rec.shown.heard[i] || [])
    .find((x) => x !== e && lev(x, e) <= 2 && lev(x, e) / Math.max(x.length, e.length) <= 0.5);
  const otherWords = (rec.shown.heard[i] || []).join(' '); // entendu à la place du mot (autre mot, mot ajouté)
  const st = clone(rec.shown);
  st.pos = i;
  st.back = i;
  st.ignored = 0;
  st.marks.length = i;
  st.extra = 0;
  st.pending = [];
  for (const k of Object.keys(st.heard)) if (Number(k) >= i) delete st.heard[k];
  for (const k of Object.keys(rec.posAt)) if (Number(k) >= i) delete rec.posAt[k];
  const extraWord = st.ins[i]; // rappel dû à un mot en trop ?
  const vowelWord = st.vow[i] || close; // … ou à une voyelle / lettre fausse ?
  if (vowelWord && !rec.letterFaults[i]) { const f = letterFault(rec.words[i].text, vowelWord); if (f) rec.letterFaults[i] = f; }
  for (const k of Object.keys(st.ins)) if (Number(k) >= i) delete st.ins[k];
  for (const k of Object.keys(st.vow)) if (Number(k) >= i) delete st.vow[k];
  for (const k of Object.keys(st.pron)) if (Number(k) >= i) delete st.pron[k];
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
  // (mot joué : 0,6 s, le mot encore capté est ignoré grâce à rec.echo ; avec 0,4 s sans rec.echo,
  // « عَلَيْكُمْ » était capté au début d'une reprise, 29/10/2026). Bip : 0,2 s seulement, sa fin ne
  // donne que du bruit (ignoré) ; avec 1 s, le début de la reprise, dite juste après le bip, était
  // perdu (« مِنْ شَ » manquant devant « رِّ الْوَسْوَاسِ », l'application se perdait, 31/10/2026)
  const after = (ms) => () => setTimeout(resume, rec.engine === 'server' ? ms : 0);
  rec.echo = null;
  const word = rec.words[i].text;
  // explication détaillée dans l'encadré (la ligne du bas est remplacée par les mots entendus
  // dès la reprise) ; pour un oubli ou un autre mot, le mot attendu n'est montré qu'à la prononciation
  const vowelFix = vowelWord ? [['🔤 Prononciation : vous avez dit'], [vowelWord, 'bad'], ['au lieu de'], [markedWord(word, vowelWord)], [vowelExplain(word, vowelWord), '', true], [drillButton(i)]] : null;
  // toute alerte dit pourquoi : mot ajouté (lequel), autre mot dit (lequel), ou mot sauté, et où
  // reprendre (après le mot précédent, sans dévoiler le mot attendu au premier bip)
  const prev = i > 0 && rec.words[i - 1].s === rec.words[i].s ? rec.words[i - 1].text : '';
  const where = prev ? [['après'], [prev, 'ok']] : [['au début du verset']];
  // mots dits à la place (ou en trop) venant d'un autre verset : ce verset complet est montré
  rec.firstSaid[i] ||= extraWord || otherWords || '';
  const src = !vowelWord && (extraWord || otherWords) ? sourceNode(extraWord || otherWords, i) : null;
  const reason = otherWords
    ? [['🔁 Vous avez dit'], [otherWords, 'bad'], ['mais ce n\'est pas le mot qui vient'], ...where, ['(mot ajouté ou remplacé).', '', true], [src]]
    : [['⏭ Un mot a été sauté'], ...where, ['(rien n\'a été entendu à sa place).', '', true]];
  if (rec.retries[i] <= rec.beeps) {
    micLog(({ beep: 'bip', tick: 'éclair + tic', watch: 'éclair + bip de montre' }[rec.signal] || 'éclair') + ' au mot ' + (i + 1));
    $('#heard').textContent = extraWord ? `🔔 Mot en trop : « ${extraWord} »` : vowelWord ? '🔔 Prononciation. Reprenez ce mot.'
      : otherWords ? `🔔 Autre mot entendu : « ${otherWords} »` : '🔔 Mot sauté : reprenez à l\'endroit indiqué.';
    showFix(extraWord ? [['➕ Mot en trop :'], [extraWord, 'bad'], ['ajouté à tort. Reprenez sans lui.'], [src]]
      : vowelFix || [...reason, ['Reprenez à cet endroit.', '', true]]);
    if (rec.signal === 'beep') playBeep(after(200));
    else { flashSignal(); after(0)(); }
  } else {
    micLog('prononciation du mot ' + (i + 1));
    rec.echo = rec.words[i].norm; // s'il est encore capté au début de la reprise : ignoré
    $('#heard').textContent = '🔊 Écoutez le mot';
    showFix(extraWord ? [['➕ Mot en trop :'], [extraWord, 'bad'], ['ajouté à tort. Le mot attendu :'], [word, 'ok'], [src]]
      : vowelFix || (otherWords ? [['🔁 Vous avez dit'], [otherWords, 'bad'], ['au lieu de'], [word, 'ok'], ['Écoutez, puis reprenez ce mot.', '', true], [src]]
        : [['⏭ Mot sauté :'], [word, 'ok'], ['Écoutez, puis reprenez ce mot.', '', true]]));
    sayWords([i], after(600));
  }
}

// Verset d'où viennent des mots dits à la place du bon (versets semblables : « يَفْعَلُ » pour « يَخْلُقُ »
// en 3:47 vient de 3:40) : la plus longue suite de vrais mots du Coran, dans le verset le plus proche
// (même sourate d'abord). null si rien de sûr (mot court seul, bruit). 05/11/2026
let normAyahs = null;
function sourceOf(said, w) {
  const h = String(said || '').split(/\s+/).map(norm).filter(Boolean);
  if (!h.length) return null;
  normAyahs ||= QURAN.map((s) => s.a.map((a) => a.split(/\s+/).filter((t) => norm(t)).map((t) => ({ t, n: norm(t) }))));
  for (let n = h.length; n >= 1; n--) {
    for (let a = 0; a + n <= h.length; a++) {
      const seq = h.slice(a, a + n);
      if (n === 1 && seq[0].length < 3) continue;
      let best = null;
      normAyahs.forEach((ayahs, si) => ayahs.forEach((ws, ai) => {
        for (let k = 0; k + n <= ws.length; k++) {
          if (!seq.every((x, j) => ws[k + j].n === x)) continue;
          const score = (si === w.s - 1 ? 0 : 10000) + Math.abs(ai + 1 - w.ayah);
          if (!best || score < best.score) best = { score, s: si + 1, ayah: ai + 1, k, n };
        }
      }));
      if (best) return best;
    }
  }
  return null;
}

// Verset en texte, mots k..k+n-1 en évidence (classe hl)
function ayahHtml(s, ayah, k, n, hl) {
  return normAyahs[s - 1][ayah - 1].map(({ t }, j) => (j >= k && j < k + n ? `<span class="${hl}">${t}</span>` : t)).join(' ');
}

// Bilan, mot remplacé ou ajouté venant d'un autre verset : les deux versets complets l'un sous
// l'autre, l'attendu (mot attendu en vert) et celui d'où vient ce qui a été dit (en rouge)
function compareHtml(i, kind, heard) {
  if (kind !== 'subst' && kind !== 'extra') return '';
  const w = rec.words[i], said = heard || rec.firstSaid[i], src = said && sourceOf(said, w);
  if (!src) return '';
  return `<div class="cmp"><div><small>Attendu · ${QURAN[w.s - 1].en} ${w.ayah}</small>`
    + `<div class="ar" dir="rtl">${ayahHtml(w.s, w.ayah, w.k, 1, 'exp')}</div></div>`
    + `<div><small>Vous avez dit « ${escapeHtml(said)} » · vient de ${QURAN[src.s - 1].en} ${src.ayah}</small>`
    + `<div class="ar" dir="rtl">${ayahHtml(src.s, src.ayah, src.k, src.n, 'said')}</div></div></div>`;
}

// Encadré « vient de » sous l'explication d'une erreur : le verset complet où se trouvent les mots dits
function sourceNode(said, i) {
  const src = sourceOf(said, rec.words[i]);
  if (!src) return null;
  const div = document.createElement('div');
  div.className = 'fix-src';
  div.innerHTML = `📖 « ${escapeHtml(said)} » vient de ${QURAN[src.s - 1].en} ${src.ayah} :`
    + `<div class="ar" dir="rtl" lang="ar">${ayahHtml(src.s, src.ayah, src.k, src.n, 'said')}</div>`;
  return div;
}
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Lettre dite comme une autre (« سِرَاطٍ » pour « صِرَاطٍ ») : bouton pour répéter ce mot tout de suite,
// comparé au récitateur, jusqu'à ce qu'il soit bon ; on revient ensuite au verset sur ce mot (02/11/2026)
function drillButton(i) {
  const f = rec.letterFaults[i];
  if (!f || rec.engine !== 'server' || !LETTER_TIPS[f.exp]) return null;
  const div = document.createElement('div'), b = document.createElement('button');
  b.className = 'btn fix-drill';
  b.textContent = `🎯 Répéter ce mot jusqu'au vert`;
  b.addEventListener('click', () => openDrillWord(i));
  div.append(b);
  return div;
}

// Encadré d'explication d'une erreur, en haut de l'écran, en grand : morceaux [texte, mot arabe
// entendu (bad) ou attendu (ok), ligne à part ?].
// Il reste affiché pendant la reprise (15 s), et disparaît à l'erreur suivante ou en fin de récitation.
function showFix(parts) {
  const box = $('#fix');
  box.textContent = '';
  for (const [text, ar, line] of parts) {
    if (!text) continue;
    if (text instanceof Node) { box.append(text, ' '); continue; } // mot déjà construit (markedWord)
    const el = document.createElement(line ? 'div' : 'span');
    el.textContent = text;
    if (ar) { el.className = 'ar ' + ar; el.dir = 'rtl'; el.lang = 'ar'; }
    box.append(el, ' ');
  }
  box.hidden = false;
  clearTimeout(showFix.timer);
  showFix.timer = setTimeout(() => { box.hidden = true; rec.lastProgress = Date.now(); }, 15000);
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
  forgot: 'oublié', subst: 'autre mot', extra: 'mot en trop avant', hint: 'montré après une hésitation', pron: 'mal prononcé',
};

function playWord(i) {
  sayEl.onended = sayEl.onerror = null;
  sayEl.src = wordAudioUrl(rec.words[i]);
  sayEl.play().catch(() => { /* hors ligne */ });
}

function finish() {
  $('#lens').hidden = true;
  stopListening();
  // micro arrêté avant la fin (05/11/2026) : bilan des seuls mots déjà récités (les suivants ne
  // comptent ni justes ni faux) ; « À revoir » et le bilan envoyé au serveur attendent la vraie fin
  const n = Math.min(rec.shown.pos, rec.words.length), partial = n < rec.words.length;
  const marks = rec.words.slice(0, n).map((_, i) => markOf(rec.shown, i));
  const ok = marks.filter((m) => m === 'ok').length;
  const unsure = marks.filter((m) => m === 'unsure').length;
  const pct = Math.round((ok / Math.max(1, n - unsure)) * 100);
  // progrès des mots « À revoir » : une seule fois par récitation (finish peut être rappelé)
  const first = !partial && rec.reviewOut === null;
  if (first) rec.reviewOut = updateReview();
  const flagged = [...rec.flagged].sort((x, y) => x - y).map((i) => rec.words[i]);

  // les mots à retravailler, par nature d'erreur : mémoire (oubli, autre mot, mot en trop,
  // indice), prononciation, et mots justes que le micro avait mal entendus (validés en les touchant)
  const memory = [], pron = [], misheard = [];
  rec.words.slice(0, n).forEach((w, i) => {
    const m = marks[i];
    if (rec.overrides.has(i)) { misheard.push({ i }); return; }
    if (m === 'ok' || rec.forcedBad.has(i)) return; // marqué faux à la main : dans « À revoir »
    const fixed = m === 'fixed';
    // mot montré (en gris) après un rappel : on garde la vraie raison de l'erreur (mot en trop, oubli…)
    const shown = m === 'hint' && rec.firstErr[i];
    const kind = fixed || shown ? rec.firstErr[i] || 'forgot' : m === 'unsure' ? 'forgot' : errorKind(rec.shown, i);
    const heard = fixed ? '' : rec.shown.ins[i] || rec.shown.vow[i] || (kind !== 'forgot' && (rec.shown.heard[i] || []).join(' ')) || '';
    const why = !fixed && rec.shown.vow[i] ? vowelExplain(rec.words[i].text, rec.shown.vow[i]) : '';
    (kind === 'pron' ? pron : memory).push({ i, kind, fixed, heard, why, shown });
  });
  // lettres dites comme une autre (aussi pour les mots sans rappel)
  for (const p of pron) {
    if (!rec.letterFaults[p.i] && rec.shown.vow[p.i]) { const f = letterFault(rec.words[p.i].text, rec.shown.vow[p.i]); if (f) rec.letterFaults[p.i] = f; }
  }
  const letters = letterReport(marks, !partial);
  const letterWords = letters.flatMap((l) => l.words.map((i) => ({ i })));
  const lettersHtml = letters.length
    ? `<div class="rv"><b>🔤 Lettres à travailler</b><br><small>Prononcées autrement que par les récitateurs : écoutez (🔊) le mot, puis répétez-le en soignant la lettre.</small>`
      + letters.map((l) => `<div class="rl"><span class="rw" dir="rtl">${l.exp}</span> dite comme <span class="rw" dir="rtl">${l.got}</span>`
        + ` dans ${l.n} mot(s) sur ${l.withL}<br><small>${l.tip}</small><br>`
        + l.words.map((i) => `<button class="say-w" data-i="${i}" aria-label="Écouter">🔊</button><span class="rw" dir="rtl">${rec.words[i].text}</span>`).join(' ')
        + `<br><button class="btn drill-go" data-l="${l.exp}" data-alt="${l.got}">🎯 M'entraîner sur ${l.exp} (comparé au récitateur)</button>`
        + '</div>').join('')
      + '<button id="btn-redo-letters" class="btn primary">🎤 Réciter à nouveau ces versets</button></div>'
    : '';
  const line = ({ i, kind, fixed, heard, why, shown }) => {
    const w = rec.words[i];
    return `<div class="rl"><button class="say-w" data-i="${i}" aria-label="Écouter">🔊</button>`
      + `<span class="rw" dir="rtl">${w.text}</span> <small>${QURAN[w.s - 1].en} ${w.ayah}`
      + (kind ? ` · ${KIND_LABEL[kind]}` : '') + (heard ? ` (entendu « <bdi dir="rtl">${heard}</bdi> »)` : '') + (why ? ` · ${why}` : '')
      + (fixed ? ' · retrouvé après le bip' : '') + (shown ? ' · mot montré' : '') + '</small></div>'
      + compareHtml(i, kind, heard);
  };
  const group = (title, list, help, id) => (list.length
    ? `<div class="rv"><b>${title} : ${list.length}</b><br><small>${help}</small>${list.map(line).join('')}`
      + (id ? `<button id="${id}" class="btn primary">🎤 Réciter à nouveau ces versets</button>` : '') + '</div>'
    : '');

  // dans l'ordre demandé (05/11/2026) : mots où l'on s'est trompé, puis mots oubliés, puis prononciation
  const wrong = memory.filter((x) => x.kind === 'subst' || x.kind === 'extra');
  const forgot = memory.filter((x) => !wrong.includes(x));
  $('#summary').innerHTML = (partial ? `<small>⏸ Micro arrêté au mot ${n} sur ${rec.words.length} : bilan des mots déjà récités. 🎤 pour reprendre.</small><br>` : '')
    + `<b>${pct} %</b><br>✅ ${ok} mot(s) juste(s) du premier coup`
    + (rec.reviewOut ? `<br>🎉 ${rec.reviewOut} mot(s) sorti(s) de « À revoir »` : '')
    + group('❌ Trompé', wrong, 'Un autre mot dit à la place, ou un mot en trop : réciter ces versets encore.', 'btn-redo-wrong')
    + group('🕳 Oublié', forgot, 'Mots oubliés ou montrés après une hésitation : réciter ces versets encore.', 'btn-redo-forgot')
    + group('🗣 Mal prononcé', pron, 'Écoutez (🔊) puis répétez le mot.', 'btn-redo-pron')
    + lettersHtml
    + pronSummaryHtml()
    + group('🎙 Mal entendus par le micro', misheard, 'Vous les avez touchés pour les valider : ils comptent justes.')
    + (flagged.length
      ? `<div class="rv">🚩 À revoir : ${flagged.length} mot(s)<br>${flagged.map((w) => `<span class="rw" dir="rtl">${w.text}</span> <small>(${QURAN[w.s - 1].en} ${w.ayah})</small>`).join('<br>')}</div>`
        + '<button id="btn-review-these" class="btn primary">🎤 Réviser ces versets</button>'
      : '');
  $('#summary').hidden = false;
  $('#fix').hidden = true;
  $('#talk').scrollTop = 0;
  // le même bilan en texte, gardé par le serveur avec le diagnostic (plus besoin de capture d'écran) ;
  // aussi à l'arrêt du micro : le journal du micro (réglages de l'iPad, volume) arrive même sans fin (v87)
  if ((first || partial) && window.sendReport) {
    const txt = ({ i, kind, fixed, heard, why, shown }) => `${rec.words[i].text} (${rec.words[i].s}:${rec.words[i].ayah}, mot ${i + 1})`
      + (kind ? ` · ${KIND_LABEL[kind]}` : '') + (heard ? ` (entendu « ${heard} »)` : '') + (why ? ` · ${why}` : '')
      + (fixed ? ' · retrouvé après le bip' : '') + (shown ? ' · mot montré' : '');
    sendReport([
      `Bilan « ${current.title} »${partial ? ` (micro arrêté au mot ${n})` : ''} : ${pct} % · ${ok}/${rec.words.length} mots justes du premier coup · niveau ${rec.level}`,
      ...memory.map((x) => '🧠 ' + txt(x)), ...pron.map((x) => '🗣 ' + txt(x)), ...misheard.map((x) => '🎙 ' + txt(x)),
      ...letters.map((l) => `🔤 ${l.exp} dite comme ${l.got} : ${l.n} mot(s) sur ${l.withL} (${l.words.map((i) => rec.words[i].text).join(' ')})`),
      ...flagged.map((w) => `🚩 ${w.text} (${w.s}:${w.ayah})`), ...pronSummaryText(),
      '', 'Journal du micro :', ...micLines,
    ].join('\n'));
  }
  $('#summary').querySelectorAll('.say-w').forEach((b) => b.addEventListener('click', () => playWord(+b.dataset.i)));
  const redo = (title, list) => {
    current = { title, ayahs: reviewAyahs(list.map(({ i }) => ({ s: rec.words[i].s, a: rec.words[i].ayah, k: rec.words[i].k }))) };
    openRecite();
  };
  $('#btn-redo-wrong')?.addEventListener('click', () => redo('Trompé', wrong));
  $('#btn-redo-forgot')?.addEventListener('click', () => redo('Oublié', forgot));
  $('#btn-redo-pron')?.addEventListener('click', () => redo('Prononciation', pron));
  $('#btn-redo-letters')?.addEventListener('click', () => redo('Lettres', letterWords));
  // entraînement : d'abord les mots où la lettre a été manquée, puis d'autres mots du passage qui la contiennent
  $('#summary').querySelectorAll('.drill-go').forEach((b) => b.addEventListener('click', () => {
    const l = letters.find((x) => x.exp === b.dataset.l);
    const others = rec.words.map((w, i) => i).filter((i) => rec.words[i].norm.includes(l.exp) && !l.words.includes(i));
    const seen = new Set();
    const words = [...l.words, ...others].map((i) => rec.words[i]).filter((w) => !seen.has(w.norm) && seen.add(w.norm));
    openDrill(l.exp, b.dataset.alt, words);
  }));
  $('#btn-review-these')?.addEventListener('click', () => redo('À revoir', flagged.map((w) => ({ i: rec.words.indexOf(w) }))));
}

// Texte entendu depuis le début de la session. Sur Android, un segment peut répéter
// le précédent en le complétant (« قل هو » puis « قل هو الله ») : on garde le plus long.
function sessionText(results, a) {
  // serveur Hifz : les morceaux sont toujours distincts, on les met bout à bout
  if (rec.engine === 'server') {
    const segs = results.filter((r) => r[0].transcript.trim());
    // dernier mot de chaque morceau : le serveur coupe aux pauses, donc à un arrêt (rec.segEnds :
    // indices des mots, la voyelle finale n'y est pas exigée) ; sauf morceau coupé de force (cut :
    // trop long, sans pause : « فِي جِيدِهَا حَبْلٍ » au lieu de « حَبْلٌ » passait, 31/10/2026)
    rec.segEnds = new Set();
    rec.pronHeard = []; // probabilité des lettres, mot par mot (mêmes mots que le texte renvoyé)
    let n = 0;
    for (const r of segs) {
      const ws = r[0].transcript.trim().split(/\s+/);
      ws.forEach((w, j) => { if (norm(w)) rec.pronHeard.push(r.pron?.[j] || null); });
      n += ws.filter((w) => norm(w)).length;
      if (!r.cut) rec.segEnds.add(n - 1);
    }
    return segs.map((r) => r[0].transcript.trim()).join(' ');
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
    alignPron = rec.engine === 'server' && rec.pronHeard ? rec.pronHeard.slice(rec.offset) : null;
    let h = heard.slice(rec.offset), rw = raw.slice(rec.offset), sp = stops;
    // serveur : mots recoupés selon le texte attendu (voir recut)
    if (rec.engine === 'server' && recutOn) ({ heard: h, raw: rw, stops: sp, pron: alignPron } = recut(h, rw, sp, alignPron, rec.base.pos));
    const st = align(clone(rec.base), h, rw, sp, rec.engine === 'server' && !isFinal);
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
  if (autoPause(bestText, newWords)) return;
  rec.heardCount = bestCount;
  const tail =bestText.split(/\s+/).slice(-5).join(' '); // cadre du bas : les 5 derniers mots, en grand (demande du 05/11/2026)
  // mots dits après le mot faux (signal pas suivi) : pas affichés en bas, ils dévoileraient la suite
  const waiting = best.back >= 0 && best.back === best.pos && best.ignored > 0;
  $('#heard').textContent = waiting ? '⏪ Revenez au mot faux.'
    : rec.showDelay && newWords > 0 ? `⏱ ${(gap / 1000).toFixed(1)} s · ${tail}` : tail;
  setShown(best, isFinal);
  if (rec.engine === 'server') pronUpdate(rec.shown, isFinal);
  // on a continué après le signal : rappel de revenir au mot faux (une fois par erreur)
  if (best.back >= 0 && best.back === best.pos && best.ignored >= 2 && rec.backShown !== best.back) {
    rec.backShown = best.back;
    const p = best.pos, prev = p > 0 && rec.words[p - 1].s === rec.words[p].s ? rec.words[p - 1].text : '';
    micLog(`signal pas suivi : ${best.ignored} mots plus loin ignorés`);
    flashSignal();
    showFix(prev ? [['⏪ Revenez au mot faux : reprenez après'], [prev, 'ok']] : [['⏪ Revenez au mot faux : reprenez au début du verset.']]);
  }
}
// Pause automatique (serveur) : on parle à quelqu'un, au téléphone, la télé… le modèle écrit cette
// parole en lettres arabes sans aucun sens et chaque mot attendu était refusé deux fois, puis montré
// (46 rappels en 10 min le 05/11/2026). Sur les 25 dernières secondes, si au moins 12 mots ont été
// entendus sur 20 s ou plus et que moins de 40 % sont des mots du Coran ou ressemblent à un mot du
// passage (une récitation mal comprise, avec la télé, reste au-dessus : aucune pause sur les séances
// du 04/11 et du 05/11, pause 24 s après le début de la conversation du 05/11) : pause, rien n'est compté.
const NOISE_WINDOW_MS = 25000, NOISE_MIN_WORDS = 12, NOISE_MIN_SPAN_MS = 20000, NOISE_QURAN_SHARE = 0.4;
function recitationLike(n) {
  if (isQuranWord(n)) return true;
  if (n.length < 3) return false;
  const p = rec.shown?.pos || 0;
  return rec.words.slice(Math.max(0, p - 30), p + 60).some((e) => Math.abs(e.norm.length - n.length) <= 2
    && lev(n, e.norm) <= Math.max(1, Math.floor(Math.max(n.length, e.norm.length) * 0.4)));
}
function autoPause(text, newWords) {
  if (rec.engine !== 'server' || !rec.listening || rec.pausing || newWords <= 0) return false;
  const now = Date.now(), words = text.split(/\s+/).filter((t) => norm(t)).slice(-newWords);
  for (const w of words) rec.recentHeard.push({ t: now, q: recitationLike(norm(w)) });
  rec.recentHeard = rec.recentHeard.filter((x) => now - x.t <= NOISE_WINDOW_MS);
  const R = rec.recentHeard;
  if (R.length < NOISE_MIN_WORDS || now - R[0].t < NOISE_MIN_SPAN_MS) return false;
  const share = R.filter((x) => x.q).length / R.length;
  if (share >= NOISE_QURAN_SHARE) return false;
  micLog(`pause automatique : ${Math.round(share * 100)} % de mots du Coran sur ${R.length} mots entendus`);
  window.sendReport?.(['Pause automatique (pas de récitation reconnue)', '', 'Journal du micro :', ...micLines].join('\n'));
  stopListening();
  rec.recentHeard = [];
  $('#fix').hidden = true;
  $('#heard').textContent = '⏸ Je n\'entends plus de récitation (conversation, télé…) : rien n\'est compté. Touchez 🎤 pour reprendre.';
  render();
  return true;
}

const LATE_WORDS = 5;   // mots arrivés d'un coup
const LATE_MS = 2500;   // attente depuis la réponse précédente

// Reconnaissance utilisable : celle du navigateur, ou le serveur Hifz (si une adresse est réglée)
// serveur : toujours disponible, l'adresse est cherchée (annonce du serveur) au toucher du micro
const recognitionAvailable = () => (rec.engine === 'server' ? true : !!SR);

// Le serveur Hifz renvoie le texte avec les voyelles : on les vérifie (sauf en Très souple)
const vowelCheck = () => rec.engine === 'server';

// Serveur arrêté et jeton GitHub enregistré (⚙) : on le démarre depuis le téléphone, puis le micro
// s'ouvre tout seul quand il est prêt (2 à 3 minutes). Renvoie false sans jeton.
async function serverBootFlow() {
  if (rec.booting) return true;
  if (!store.get('ghToken', '')) return false;
  rec.booting = true;
  const el = $('#heard');
  let clock = 0;
  try {
    await bootServer();
    // sablier qui tourne et secondes écoulées sous le message, jusqu'à ce que le serveur soit prêt (05/11/2026)
    el.innerHTML = '<div>🚀 Démarrage du serveur Hifz (2 à 3 minutes)… le micro s\'ouvrira tout seul.</div>'
      + '<div class="boot-wait"><span class="hourglass">⏳</span><b class="boot-s">0 s</b><i class="boot-bar"><i></i></i></div>';
    const t0 = bootAt || Date.now(); // démarrage peut-être déjà demandé à l'ouverture de l'application
    clock = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000), n = el.querySelector('.boot-s'), bar = el.querySelector('.boot-bar i');
      if (!n) { clearInterval(clock); return; } // message remplacé
      n.textContent = s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
      bar.style.width = `${Math.min(95, (s / 150) * 100)}%`;
    }, 1000);
    const ok = await waitServerUp(() => {});
    clearInterval(clock);
    if (!ok) el.textContent = 'Le serveur ne démarre pas : réessayez, ou lancez « Démarrer Hifz » sur le PC.';
    else if (!views.recite.hidden && !rec.listening) { el.textContent = '✅ Serveur prêt : récitez.'; rec.booting = false; startListening(); }
  } catch (e) {
    el.textContent = `Démarrage impossible (${e.message}) : vérifiez le jeton GitHub dans ⚙.`;
  } finally {
    clearInterval(clock);
    rec.booting = false;
  }
  return true;
}

function startListening(again = false) {
  if (rec.booting) return;
  if (rec.engine === 'server' && rec.serverState !== 'up' && store.get('ghToken', '')) { serverBootFlow(); return; }
  if (!recognitionAvailable() || rec.listening) return;
  if (rec.committed.pos >= rec.words.length) resetRecite();
  $('#summary').hidden = true; // bilan partiel d'un arrêt du micro : on reprend
  rec.listening = true;
  rec.lastProgress = Date.now();
  $('#btn-mic').classList.add('on');
  if (!again) { micT0 = Date.now(); micLines.length = 0; rec.recentHeard = []; }
  micLog(again ? 'micro relancé (retour au verset)' : 'micro lancé');
  startRecognizer();
  if (rec.engine === 'server') pronPrefetch();
  rec.timer = setInterval(() => {
    // après 5 s sans progression (8 s avec le serveur, qui répond avec un peu de retard), le mot
    // attendu apparaît en gris ; pas pendant la lecture de l'explication d'une erreur (#fix)
    const p = rec.shown.pos;
    const wait = rec.engine === 'server' ? 8000 : 5000;
    if (!rec.pausing && $('#fix').hidden && p < rec.words.length && !rec.peeked.has(p) && Date.now() - rec.lastProgress > wait) {
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
      // serveur arrêté sans l'avoir annoncé (coupé par Kaggle) : démarrage depuis le téléphone si possible
      if (store.get('ghToken', '')) { stopListening(); rec.serverState = 'down'; serverBootFlow(); return; }
      $('#heard').textContent = rec.serverState === 'down'
        ? 'Le serveur Hifz est arrêté : lancez « Démarrer Hifz » sur le PC (2 à 3 minutes), puis réessayez.'
        : 'Serveur Hifz injoignable : il démarre peut-être encore, réessayez dans une minute (ou repassez sur « Téléphone » dans ⚙).';
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
  // arrêt du micro : bilan des mots déjà récités, tout de suite (05/11/2026)
  if (rec.listening) { stopListening(); if (rec.committed.pos > 0) finish(); return; }
  unlockSayAudio();
  startListening();
});
$('#btn-restart').addEventListener('click', resetRecite);
// Nouvelle écoute du micro (démarrage, relance automatique, reprise après un rappel) :
// chacune commence par un bip sur Android, d'où la tolérance sur les premiers mots.
function newSession() {
  rec.base = clone(rec.committed);
  rec.lastFinalPos = rec.base.pos; // mots manquants vérifiés au texte définitif à partir d'ici (checkReplay)
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
$('#opt-recut').checked = recutOn;
$('#opt-recut').addEventListener('change', () => { recutOn = $('#opt-recut').checked; store.set('recut', recutOn); });
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

$('#signal').value = rec.signal;
$('#signal').addEventListener('change', () => {
  rec.signal = $('#signal').value;
  store.set('signal', rec.signal);
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
  store.set('level3', rec.level);
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

// Mise à jour automatique (06/11/2026) : le téléphone garde la page ouverte en arrière-plan, et
// rouvrir l'application la reprend telle quelle (l'utilisateur restait en v75 alors que v77 était en
// ligne). À l'ouverture et à chaque retour dans l'application, on compare le numéro de version en
// ligne ; s'il a changé, la page est rechargée (sauf pendant une récitation ou une écoute).
const appVersion = () => ($('#app-version').textContent.match(/\d+/) || [''])[0];
$('#learn-version').textContent = $('#app-version').textContent;
async function checkUpdate() {
  if (location.protocol === 'file:' || rec.listening || rec.booting || playlist.length) return;
  try {
    const html = await (await fetch(`index.html?v=${Date.now()}`, { cache: 'no-store' })).text();
    const online = (html.match(/id="app-version">Version (\d+)/) || [])[1];
    // (une seule tentative par version : pas de boucle si le site sert encore l'ancienne page)
    if (online && online !== appVersion() && sessionStorage.getItem('reloadedFor') !== online) {
      sessionStorage.setItem('reloadedFor', online);
      location.reload();
    }
  } catch { /* hors ligne : on garde la version en cache */ }
}
setTimeout(checkUpdate, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });
