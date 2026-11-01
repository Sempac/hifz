// ---------- Niveau de prononciation, comparé au récitateur ----------
// Le serveur Hifz donne, pour chaque mot récité, la probabilité de chacune de ses lettres (le
// modèle est entraîné sur des récitateurs : un « ص » qui sonne comme un « س » a une probabilité
// basse). La même mesure est faite une fois sur le récitateur, mot par mot (audio.qurancdn.com),
// et gardée dans le téléphone. 100 % = la lettre est aussi nette que chez le récitateur.
// Barre à droite (en face de la jauge du micro) : le dernier mot récité, sa lettre la plus faible ;
// à la fin de chaque verset, sa note et les mots les plus éloignés ; résumé dans le bilan.
const PRON_OK = 80;      // vert à partir de 80 %
const PRON_WEAK = 50;    // rouge en dessous de 50 %
const PRON_REF_MIN = 30; // lettre peu nette même chez le récitateur : pas comparée
const refPron = store.get('refPron', {}); // url du mot (récitateur) → { l: lettres, s: probabilités }

// Lettre la plus faible du mot i, comparée au récitateur : { v: %, l: lettre } (null : pas de mesure)
function pronWord(i, st = rec.shown) {
  const p = st.pron?.[i], r = refPron[wordAudioUrl(rec.words[i])];
  if (!p || !r || !p.l || p.l !== r.l) return null;
  let worst = null;
  p.s.forEach((u, k) => {
    // alif de liaison en tête (« ال » dit en continu) : il ne se prononce pas, le modèle l'écrit quand même
    if (k === 0 && p.l[0] === 'ا') return;
    if (r.s[k] < PRON_REF_MIN) return;
    const v = Math.min(100, Math.round((100 * u) / r.s[k]));
    if (!worst || v < worst.v) worst = { v, l: p.l[k] };
  });
  return worst;
}

// Mesures du récitateur pour les mots du passage qui n'en ont pas encore (par paquets de 40)
async function pronPrefetch() {
  if (pronPrefetch.busy || !rec.serverUrl) return;
  const base = rec.serverUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws$/, '');
  const todo = [...new Map(rec.words.map((w) => [wordAudioUrl(w), w.text])).entries()].filter(([u]) => !refPron[u]);
  pronPrefetch.busy = true;
  try {
    for (let k = 0; k < todo.length; k += 40) {
      const part = todo.slice(k, k + 40);
      const r = await fetch(`${base}/pronref`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: part.map(([url, word]) => ({ url, word })) }),
      }).then((x) => x.json());
      part.forEach(([u], j) => { if (r.ref?.[j]?.l) refPron[u] = r.ref[j]; });
      store.set('refPron', refPron);
    }
  } catch { /* serveur ancien (sans /pronref) ou injoignable : pas de niveau */ }
  pronPrefetch.busy = false;
}

const pronClass = (v) => (v >= PRON_OK ? 'ok' : v >= PRON_WEAK ? 'mid' : 'low');

// Après chaque réponse du serveur : barre du dernier mot juste mesuré, note du verset terminé
function pronUpdate(st, final) {
  const bar = $('#pron');
  for (let i = st.pos - 1; i >= Math.max(0, st.pos - 3); i--) {
    const m = markOf(st, i);
    const x = m === 'ok' && pronWord(i, st);
    if (!x) continue;
    bar.hidden = false;
    bar.className = 'pron ' + pronClass(x.v);
    bar.firstElementChild.style.height = Math.max(4, x.v) + '%';
    bar.lastElementChild.innerHTML = `<span lang="ar">${x.l}</span><span>${x.v}%</span>`;
    break;
  }
  if (!final) return;
  rec.pronDone ||= new Set();
  for (let i = 0; i < st.pos; i++) {
    const w = rec.words[i], next = rec.words[i + 1];
    const key = `${w.s}:${w.ayah}`;
    if ((next && next.s === w.s && next.ayah === w.ayah) || rec.pronDone.has(key)) continue;
    rec.pronDone.add(key);
    if (i === st.pos - 1 || i === st.pos - 2) showAyahNote(w.s, w.ayah, st); // verset qu'on vient de finir
  }
}

// Note d'un verset : moyenne des mots mesurés ; mots faibles : sous PRON_OK, les 3 plus bas
function ayahPron(s, a, st = rec.shown) {
  const items = [];
  rec.words.forEach((w, i) => {
    if (w.s !== s || w.ayah !== a || markOf(st, i) !== 'ok') return;
    const x = pronWord(i, st);
    if (x) items.push({ i, ...x });
  });
  if (!items.length) return null;
  const note = Math.round(items.reduce((t, x) => t + x.v, 0) / items.length);
  return { note, weak: items.filter((x) => x.v < PRON_OK).sort((x, y) => x.v - y.v).slice(0, 3) };
}

function showAyahNote(s, a, st) {
  const r = ayahPron(s, a, st);
  if (!r) return;
  const el = $('#pron-note');
  el.className = 'pron-note ' + pronClass(r.note);
  el.innerHTML = `🎙 Verset ${a} : <b>${r.note}/100</b>`
    + r.weak.map((x) => ` · <button class="pw" data-i="${x.i}"><bdi lang="ar">${rec.words[x.i].text}</bdi> (${x.v} % · <bdi>${x.l}</bdi>)</button>`).join('');
  el.querySelectorAll('.pw').forEach((b) => b.addEventListener('click', () => playWord(+b.dataset.i)));
  el.hidden = false;
  clearTimeout(showAyahNote.t);
  showAyahNote.t = setTimeout(() => { el.hidden = true; }, 7000);
}

// Bilan : note par verset et mots les plus éloignés du récitateur
function pronAyahs() {
  const seen = new Set(), out = [];
  for (const w of rec.words) {
    const key = `${w.s}:${w.ayah}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = ayahPron(w.s, w.ayah);
    if (r) out.push({ s: w.s, a: w.ayah, ...r });
  }
  return out;
}

function pronSummaryHtml() {
  const list = pronAyahs();
  if (!list.length) return '';
  const avg = Math.round(list.reduce((t, x) => t + x.note, 0) / list.length);
  return `<div class="rv"><b>🎙 Prononciation comparée au récitateur : ${avg}/100</b><br>`
    + '<small>100 = les lettres sont aussi nettes que chez le récitateur. Écoutez (🔊) les mots faibles et répétez-les.</small>'
    + list.map((x) => `<div class="rl"><span class="pron-badge ${pronClass(x.note)}">${x.note}</span> ${QURAN[x.s - 1].en} ${x.a}`
      + x.weak.map((y) => ` <button class="say-w" data-i="${y.i}" aria-label="Écouter">🔊</button><span class="rw" dir="rtl">${rec.words[y.i].text}</span> <small>(${y.v} % · <bdi>${y.l}</bdi>)</small>`).join('')
      + '</div>').join('')
    + '</div>';
}

function pronSummaryText() {
  return pronAyahs().map((x) => `🎙 ${x.s}:${x.a} : ${x.note}/100`
    + x.weak.map((y) => ` · ${rec.words[y.i].text} (${y.l} ${y.v}%)`).join(''));
}

// la barre suit la jauge du micro : cachée quand le micro s'arrête
new MutationObserver(() => { if ($('#vu').hidden) $('#pron').hidden = true; })
  .observe($('#vu'), { attributes: true, attributeFilter: ['hidden'] });
