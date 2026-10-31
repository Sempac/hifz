'use strict';

// ---------- Entraînement d'une lettre (comparaison avec le récitateur) ----------
// Mot par mot : on écoute le récitateur, on répète, et le serveur Hifz mesure avec le même modèle
// (entraîné sur des récitateurs) sa « marge » : combien il préfère le mot avec la bonne lettre au
// mot avec la lettre confondue (ص plutôt que س). La même marge est mesurée sur le récitateur ; le
// mot est validé quand la vôtre atteint la moitié de la sienne (et au moins DRILL_MIN).

const DRILL_MIN = 3;
const DRILL_SHARE = 0.5;
// lettre avec laquelle on confond le plus souvent chaque lettre (si le bilan n'en a pas noté d'autre)
const CONFUSED_WITH = { 'ص': 'س', 'ض': 'د', 'ط': 'ت', 'ظ': 'ز', 'ذ': 'ز', 'ث': 'س', 'ق': 'ك', 'ح': 'ه', 'ه': 'ح', 'ع': 'ء', 'ل': 'ن', 'ر': 'ل', 'س': 'ص', 'ز': 'ذ' };

const drill = { letter: '', alt: '', words: [], i: 0, done: new Set(), busy: false };

// mots du Coran contenant la lettre (juz 30 : mots courts et connus), pour s'entraîner sans bilan
function drillWordsFor(letter, max = 10) {
  const out = [], seen = new Set();
  for (let s = 78; s <= 114 && out.length < max * 3; s++) {
    QURAN[s - 1].a.forEach((text, a) => {
      let k = 0;
      for (const t of text.split(/\s+/)) {
        const n = norm(t);
        if (!n) continue;
        if (n.includes(letter) && n.length >= 3 && n.length <= 8 && !seen.has(n)) { seen.add(n); out.push({ text: t, norm: n, s, ayah: a + 1, k }); }
        k++;
      }
    });
  }
  // un peu de tout : on prend des mots répartis dans la liste
  const step = Math.max(1, Math.floor(out.length / max));
  return out.filter((_, j) => j % step === 0).slice(0, max);
}

function openDrill(letter, alt, words) {
  drill.letter = letter;
  drill.alt = alt || store.get('letters', {})[letter]?.mainGot || CONFUSED_WITH[letter] || 'س';
  drill.words = (words && words.length ? words : drillWordsFor(letter)).slice(0, 12);
  drill.i = 0;
  drill.done = new Set();
  $('#drill-pick').hidden = true;
  $('#drill-main').hidden = false;
  $('#drill-title').textContent = `🔤 Lettre ${bidi(letter)}`;
  $('#drill-tip').textContent = `${bidi(letter)} : ${LETTER_TIPS[letter] || ''} (à ne pas confondre avec ${bidi(drill.alt)}).`;
  go('drill');
  drillShow();
}

function drillPick() {
  const stats = store.get('letters', {});
  const letters = Object.keys(LETTER_TIPS).sort((x, y) => (stats[y]?.faults || 0) - (stats[x]?.faults || 0));
  $('#drill-title').textContent = '🔤 Lettres';
  $('#drill-main').hidden = true;
  const box = $('#drill-pick');
  box.hidden = false;
  box.innerHTML = '<p class="tip">Choisissez une lettre à travailler (en premier : celles que vos récitations ont signalées).</p>'
    + letters.map((l) => `<button class="btn drill-letter" data-l="${l}"><span dir="rtl">${l}</span>`
      + (stats[l]?.faults ? ` <small>${stats[l].faults} faute(s)</small>` : '') + '</button>').join('');
  box.querySelectorAll('.drill-letter').forEach((b) => b.addEventListener('click', () => openDrill(b.dataset.l)));
  go('drill');
}

// le mot, avec la lettre travaillée en rouge
function drillWordHtml(w) {
  return laboSlots(w.text).map((s) => (norm(s.raw) === drill.letter ? `<span class="spot">${s.raw}</span>` : s.raw)).join('');
}

function drillShow() {
  const w = drill.words[drill.i];
  $('#drill-word').innerHTML = w ? drillWordHtml(w) : '';
  $('#drill-result').innerHTML = w ? '<p class="tip">🔊 Écoutez le récitateur, puis 🎤 répétez le mot.</p>' : '';
  $('#drill-progress').textContent = `Mot ${Math.min(drill.i + 1, drill.words.length)} / ${drill.words.length} · validés : ${drill.done.size}`;
  if (!w) $('#drill-result').innerHTML = `<p>🎉 Série terminée : ${drill.done.size} mot(s) validé(s) sur ${drill.words.length}.</p>`;
}

// Enregistre un mot : démarre à la voix, s'arrête après 0,6 s de silence (ou 5 s au plus)
async function drillRecord() {
  await ensureMic();
  return new Promise((resolve) => {
    const chunks = [];
    let floor = null, voiced = 0, silent = 0, total = 0;
    mic.sink = (buf) => {
      let sum = 0;
      for (let k = 0; k < buf.length; k++) sum += buf[k] * buf[k];
      const db = 10 * Math.log10(sum / buf.length / 32768 ** 2 + 1e-12);
      if (floor === null) floor = db;
      floor = Math.min(floor, db);
      const voice = db > Math.max(floor + 12, -55);
      if (voice) { voiced += 0.2; silent = 0; } else if (voiced) silent += 0.2;
      if (voiced || chunks.length < 2) chunks.push(buf); // garde un peu de son avant la voix
      total += buf.length;
      if ((voiced >= 0.2 && silent >= 0.6) || total >= 16000 * 5) {
        mic.sink = null;
        const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of chunks) { pcm.set(c, o); o += c.length; }
        resolve(voiced ? pcm : null);
      }
    };
  });
}

async function drillTry() {
  const w = drill.words[drill.i];
  if (!w || drill.busy) return;
  if (!rec.serverUrl || rec.serverState === 'down') {
    $('#drill-result').innerHTML = '<p>Le serveur Hifz est arrêté : lancez « Démarrer Hifz » sur le PC, puis réessayez.</p>';
    return;
  }
  drill.busy = true;
  $('#drill-rec').disabled = true;
  $('#drill-result').innerHTML = '<p>🎤 Je vous écoute : dites le mot…</p>';
  try {
    const pcm = await drillRecord();
    if (!pcm) { $('#drill-result').innerHTML = '<p>Je n\'ai rien entendu : réessayez, un peu plus fort.</p>'; return; }
    $('#drill-result').innerHTML = '<p>⏳ Comparaison avec le récitateur…</p>';
    const base = rec.serverUrl.replace(/^wss:/, 'https:').replace(/\/ws$/, '');
    const q = new URLSearchParams({ word: w.text, letter: drill.letter, alt: drill.alt, ref: wordAudioUrl(w) });
    const r = await fetch(`${base}/drill?${q}`, { method: 'POST', body: pcm.buffer }).then((x) => x.json());
    if (r.error || !r.user || r.user.margin === null) { $('#drill-result').innerHTML = `<p>Mesure impossible (${r.error || 'lettre absente du mot'}).</p>`; return; }
    drillVerdict(w, r);
  } catch (e) {
    $('#drill-result').innerHTML = '<p>Serveur Hifz injoignable : il démarre peut-être encore, réessayez dans une minute.</p>';
  } finally {
    drill.busy = false;
    $('#drill-rec').disabled = false;
  }
}

function drillVerdict(w, r) {
  const you = r.user.margin, ref = r.ref?.margin;
  const goal = Math.max(DRILL_MIN, ref ? ref * DRILL_SHARE : DRILL_MIN);
  const ok = you >= goal;
  const pctOf = (m) => Math.max(0, Math.min(100, Math.round((m / (ref || 10)) * 100)));
  if (ok) drill.done.add(drill.i);
  const stats = store.get('letters', {});
  const s = (stats[drill.letter] ||= { faults: 0, ok: 0, sessions: [] });
  s.drill = { tries: (s.drill?.tries || 0) + 1, ok: (s.drill?.ok || 0) + (ok ? 1 : 0), last: new Date().toISOString().slice(0, 10) };
  store.set('letters', stats);
  micLog(`entraînement ${w.text} : vous ${you}, récitateur ${ref ?? '?'}, ${ok ? 'validé' : 'à refaire'}`);
  $('#drill-result').innerHTML = `<div class="drill-bars">`
    + (ref != null ? `<div>Récitateur <span class="meter"><i style="width:100%"></i></span></div>` : '')
    + `<div>Vous <span class="meter ${ok ? 'ok' : 'bad'}"><i style="width:${pctOf(you)}%"></i></span> ${pctOf(you)} %</div></div>`
    + `<p>${ok ? `✅ Votre ${bidi(drill.letter)} est proche de celui du récitateur.`
      : you <= 0 ? `❌ Le modèle entend plutôt un ${bidi(drill.alt)}. ${LETTER_TIPS[drill.letter] || ''}`
        : `🟠 Pas encore : votre ${bidi(drill.letter)} reste faible. Écoutez et recommencez.`}</p>`
    + `<p class="tip">Entendu : « ${r.user.text || '…'} »</p>`;
  $('#drill-progress').textContent = `Mot ${drill.i + 1} / ${drill.words.length} · validés : ${drill.done.size}`;
}

$('#drill-listen').addEventListener('click', () => {
  const w = drill.words[drill.i];
  if (!w) return;
  sayEl.onended = sayEl.onerror = null;
  sayEl.src = wordAudioUrl(w);
  sayEl.play().catch(() => { /* hors ligne */ });
});
$('#drill-rec').addEventListener('click', drillTry);
$('#drill-next').addEventListener('click', () => { if (drill.i < drill.words.length) drill.i++; drillShow(); });
$('#btn-letters').addEventListener('click', () => { if (QURAN.length) drillPick(); });
