'use strict';

// ---------- Mushaf de Médine paginé (Hafs, 604 pages, 15 lignes) ----------
// Mise en page identique au livre : chaque mot est dessiné avec la police de sa page
// (polices du Complexe du Roi Fahd, édition actuelle) et placé sur sa ligne.
// Les pages se tournent comme un livre arabe : glisser de gauche à droite = page suivante.

const MUSHAF_FONT = (n) => `https://static.qurancdn.com/fonts/quran/hafs/v2/woff2/p${n}.woff2`;
// Même police avec les couleurs du tajwid (édition v4 de Quran.com : mêmes codes de mots que la v2,
// couleurs dans la police, format COLR lu par Chrome et Safari). Seulement en Lire / Écouter : en
// Hifz, les mots cachés et les couleurs juste/faux demandent une police d'une seule couleur.
const MUSHAF_FONT_TAJWEED = (n) => `https://verses.quran.com/fonts/quran/hafs/v4/colrv1/woff2/p${n}.woff2`;
const BASMALA = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ';

const mushaf = {
  data: new Map(),   // page → { w: [[ligne, glyphe, sourate, verset, position (0 = fin de verset)]], h: [[ligne, 'S', sourate] | [ligne, 'B']] }
  fonts: new Map(),  // page → promesse de chargement de la police
  flip: null,        // livre (bibliothèque page-flip)
  pages: [],         // numéros des pages du livre, dans l'ordre de lecture
  onFlip: null,      // appelé avec le numéro de la page affichée
  tajweed: false,    // livre ouvert avec la police en couleurs du tajwid
};
const mushafFamily = (n) => (mushaf.tajweed ? `qpct${n}` : `qpc${n}`);

const mushafPageData = (n) => {
  if (!mushaf.data.has(n)) mushaf.data.set(n, fetch(`data/pages/${pad3(n)}.json`).then((r) => r.json()));
  return mushaf.data.get(n);
};

const mushafFont = (n) => {
  const family = mushafFamily(n);
  if (!mushaf.fonts.has(family)) {
    const f = new FontFace(family, `url(${mushaf.tajweed ? MUSHAF_FONT_TAJWEED(n) : MUSHAF_FONT(n)})`);
    mushaf.fonts.set(family, f.load().then((ff) => { document.fonts.add(ff); }).catch(() => {}));
  }
  return mushaf.fonts.get(family);
};

// Cartouche de marge au début d'un verset : début de hizb (avec le juz quand il commence),
// ¼, ½ ou ¾ de hizb ; null sinon. Renvoie les lignes du cartouche.
function hizbMark(s, a) {
  const q = QURAN[s - 1].q[a - 1];
  const prev = a > 1 ? QURAN[s - 1].q[a - 2] : s > 1 ? QURAN[s - 2].q.at(-1) : 0;
  if (q === prev) return null;
  const part = (q - 1) % 4, hizb = Math.ceil(q / 4);
  if (part === 0) return hizb % 2 ? [`الجزء ${arNum((hizb + 1) / 2)}`, `الحزب ${arNum(hizb)}`] : [`الحزب ${arNum(hizb)}`];
  return [['', 'ربع', 'نصف', '٣/٤'][part], `الحزب ${arNum(hizb)}`];
}

// Construit l'élément d'une page. inSel(s, a) : le verset fait-il partie de la sélection ?
function buildMushafPage(n, data, inSel) {
  const page = document.createElement('div');
  // Fatiha et début de Baqara : grand cadre orné ; pages impaires à droite (reliure à leur gauche), paires à gauche
  page.className = 'mpage' + (n <= 2 ? ' opening' : '') + (n % 2 ? ' pright' : ' pleft');
  page.dataset.page = n;
  // la bibliothèque impose son propre affichage à la page : la mise en page est dans un conteneur intérieur
  const inner = document.createElement('div');
  inner.className = 'minner';
  page.appendChild(inner);
  const body = document.createElement('div');
  body.className = 'mbody' + (n <= 2 ? ' first' : '');
  const lines = n <= 2 ? 8 : 15;
  const byLine = {};
  for (const w of data.w) (byLine[w[0]] ||= []).push(w);
  const extra = Object.fromEntries(data.h.map((h) => [h[0], h]));
  for (let l = 1; l <= lines; l++) {
    const row = document.createElement('div');
    const h = extra[l];
    if (h && h[1] === 'S') {
      row.className = 'mline head';
      row.innerHTML = `<span class="sband"><span>سورة ${QURAN[h[2] - 1].name}</span></span>`;
    } else if (h && h[1] === 'B') {
      row.className = 'mline basm';
      row.textContent = BASMALA;
    } else {
      row.className = 'mline words';
      for (const [, glyph, s, a, pos] of byLine[l] || []) {
        const span = document.createElement('span');
        span.className = 'mw' + (pos ? '' : ' end') + (inSel(s, a) ? '' : ' out');
        span.style.fontFamily = mushafFamily(n);
        span.textContent = glyph;
        span.dataset.k = `${s}:${a}`;
        if (pos) span.dataset.w = `${s}:${a}:${pos}`;
        if (pos === 1) {
          const mark = hizbMark(s, a);
          if (mark) {
            const m = document.createElement('span');
            m.className = 'hmark';
            m.innerHTML = mark.flatMap((t) => t.split(' ')).map((t) => `<span>${t}</span>`).join(''); // un mot par ligne : cartouche étroit
            row.appendChild(m);
            // le premier glyphe du mot est le ۞ (« glyphe espace mot ») : agrandi à part (08/11/2026)
            const sp = glyph.indexOf(' ');
            if (sp > 0) span.innerHTML = `<span class="hstar">${glyph.slice(0, sp)}</span>${glyph.slice(sp)}`;
          }
        }
        row.appendChild(span);
      }
    }
    body.appendChild(row);
  }
  inner.appendChild(body); // le numéro de page est dans le cadre, sous la page
  return page;
}

// Taille de l'écriture : la ligne la plus longue occupe toute la largeur, et les 15 lignes
// tiennent dans la hauteur. Les lignes courtes (fin de sourate) sont centrées.
function fitMushafPage(page) {
  const body = page.querySelector('.mbody');
  const rows = [...body.querySelectorAll('.mline.words')];
  if (!rows.length) return;
  body.style.fontSize = '100px';
  body.classList.add('measuring');
  const widths = rows.map((r) => r.scrollWidth);
  body.classList.remove('measuring');
  const maxW = Math.max(...widths);
  // zone de texte réelle (sans les marges intérieures de la page)
  const cs = getComputedStyle(body);
  const availW = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const size = Math.min((100 * availW) / maxW, availH / (15 * 1.6)) * 0.98;
  body.style.fontSize = size.toFixed(2) + 'px';
  rows.forEach((r, i) => r.classList.toggle('short', (widths[i] * size) / 100 < availW * 0.85));
  page.dataset.slack = Math.max(0, availW - (maxW * size) / 100); // largeur restée vide (écran en paysage)
  // hauteur de page avec laquelle les lignes rempliraient toute la largeur
  return page.clientHeight - availH + 15 * 1.6 * ((100 * availW) / maxW);
}

// Ouvre le livre dans le conteneur host, sur les pages first … last.
// fitHeight(besoin) : facultatif, reçoit la hauteur de page qui remplirait la largeur, ajuste la
// mise en page autour et renvoie la nouvelle hauteur du conteneur (Réciter coupé en deux).
async function openMushaf(host, first, last, inSel, startPage, fitHeight) {
  closeMushaf();
  mushaf.pages = [];
  for (let n = first; n <= last; n++) mushaf.pages.push(n);
  const datas = await Promise.all(mushaf.pages.map(mushafPageData));
  await Promise.all(mushaf.pages.map(mushafFont));
  host.innerHTML = '';
  const book = document.createElement('div');
  book.className = 'mbook';
  host.appendChild(book);
  let W = host.clientWidth;
  let H = host.clientHeight;
  const els = mushaf.pages.map((n, i) => buildMushafPage(n, datas[i], inSel));
  // la bibliothèque tourne les pages comme un livre latin : on inverse l'ordre pour qu'un
  // glissement de gauche à droite mène à la page suivante (livre arabe)
  const reversed = els.slice().reverse();
  reversed.forEach((el) => { el.style.width = W + 'px'; el.style.height = H + 'px'; book.appendChild(el); });
  const need = Math.max(0, ...els.map(fitMushafPage).filter(Boolean));
  if (fitHeight && need) {
    H = fitHeight(Math.ceil(need));
    els.forEach((el) => { el.style.height = H + 'px'; });
    els.forEach(fitMushafPage);
  }
  // écran plus large que haut (iPad en paysage) : l'écriture est limitée par la hauteur ; la page
  // prend la largeur du texte, centrée, au lieu d'un cadre étiré avec le texte au milieu
  const slack = Math.min(...els.map((el) => +el.dataset.slack || 0));
  if (slack > 40 && innerWidth > innerHeight) {
    W = Math.round(W - slack);
    els.forEach((el) => { el.style.width = W + 'px'; });
    els.forEach(fitMushafPage);
    book.style.marginLeft = Math.floor((host.clientWidth - W) / 2) + 'px';
  }
  const idx = (n) => mushaf.pages.length - 1 - mushaf.pages.indexOf(n);
  mushaf.flip = new St.PageFlip(book, {
    width: W, height: H, size: 'fixed', usePortrait: true, showCover: false,
    drawShadow: true, maxShadowOpacity: 0.35, flippingTime: 700,
    mobileScrollSupport: false, swipeDistance: 25, clickEventForward: true,
    disableFlipByClick: true, showPageCorners: false,
    // glissement géré par nous (v91) : celui de la bibliothèque ne tournait la page que pour un geste
    // de moins de 250 ms, sinon il fallait tirer la page jusqu'au milieu en appuyant
    useMouseEvents: false,
    startPage: idx(startPage && mushaf.pages.includes(startPage) ? startPage : first),
  });
  mushaf.flip.loadFromHTML(reversed);
  mushaf.flip.on('flip', (e) => { updateMushafNav(); if (mushaf.onFlip) mushaf.onFlip(mushaf.pages[mushaf.pages.length - 1 - e.data]); });
  addMushafNav(host, book);
}

// Page suivante (+1) ou précédente (−1) dans l'ordre de lecture
function mushafStep(d) {
  if (!mushaf.flip || mushaf.flip.getState?.() === 'flipping') return;
  mushafGoto(mushafCurrentPage() + d);
}

// Glissement du doigt (n'importe quelle vitesse, dès 35 px à l'horizontale) et deux flèches en bas :
// de gauche à droite ou flèche de gauche = page suivante (livre arabe), l'inverse = page précédente
function addMushafNav(host, book) {
  let t0 = null;
  book.addEventListener('touchstart', (e) => { t0 = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
  book.addEventListener('touchend', (e) => {
    if (!t0) return;
    const dx = e.changedTouches[0].clientX - t0.x, dy = e.changedTouches[0].clientY - t0.y;
    t0 = null;
    if (Math.abs(dx) >= 35 && Math.abs(dx) > 1.5 * Math.abs(dy)) mushafStep(dx > 0 ? 1 : -1);
  }, { passive: true });
  if (mushaf.pages.length < 2) return;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const nav = document.createElement('div');
  nav.className = 'mnav';
  nav.innerHTML = '<button type="button" class="mnav-next" aria-label="Page suivante">❮</button>'
    + '<button type="button" class="mnav-prev" aria-label="Page précédente">❯</button>';
  nav.querySelector('.mnav-next').addEventListener('click', (e) => { e.stopPropagation(); mushafStep(1); });
  nav.querySelector('.mnav-prev').addEventListener('click', (e) => { e.stopPropagation(); mushafStep(-1); });
  host.appendChild(nav);
  updateMushafNav();
}

function updateMushafNav() {
  const cur = mushafCurrentPage();
  document.querySelectorAll('.mnav-next').forEach((b) => { b.disabled = cur >= mushaf.pages.at(-1); });
  document.querySelectorAll('.mnav-prev').forEach((b) => { b.disabled = cur <= mushaf.pages[0]; });
}

function closeMushaf() {
  if (mushaf.flip) { try { mushaf.flip.destroy(); } catch { /* déjà détruit */ } }
  mushaf.flip = null;
}

const mushafCurrentPage = () => (mushaf.flip ? mushaf.pages[mushaf.pages.length - 1 - mushaf.flip.getCurrentPageIndex()] : 0);

// Tourne jusqu'à la page n (avec l'animation si elle est voisine)
function mushafGoto(n) {
  if (!mushaf.flip || !mushaf.pages.includes(n) || n === mushafCurrentPage()) return;
  const cur = mushafCurrentPage();
  // ordre inversé : la page suivante (lecture) est la page précédente pour la bibliothèque.
  // Son flipPrev vise x = 10 sans tenir compte du décalage de la page en mode portrait
  // (bug de la bibliothèque) : on vise le coin de la page nous-mêmes.
  if (n === cur + 1) {
    const r = mushaf.flip.getRender().getRect();
    mushaf.flip.getFlipController().flip({ x: r.left + 10, y: r.height - 2 });
  } else if (n === cur - 1) mushaf.flip.flipNext('bottom');
  else mushaf.flip.turnToPage(mushaf.pages.length - 1 - mushaf.pages.indexOf(n));
}

// Page d'un mot ou d'un verset affiché dans le livre
function mushafPageOf(selector) {
  const el = document.querySelector(`.mbook ${selector}`);
  return el ? Number(el.closest('.mpage').dataset.page) : 0;
}
