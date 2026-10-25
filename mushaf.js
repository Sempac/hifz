'use strict';

// ---------- Mushaf de Médine paginé (Hafs, 604 pages, 15 lignes) ----------
// Mise en page identique au livre : chaque mot est dessiné avec la police de sa page
// (polices du Complexe du Roi Fahd, édition actuelle) et placé sur sa ligne.
// Les pages se tournent comme un livre arabe : glisser de gauche à droite = page suivante.

const MUSHAF_FONT = (n) => `https://static.qurancdn.com/fonts/quran/hafs/v2/woff2/p${n}.woff2`;
const BASMALA = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ';

const mushaf = {
  data: new Map(),   // page → { w: [[ligne, glyphe, sourate, verset, position (0 = fin de verset)]], h: [[ligne, 'S', sourate] | [ligne, 'B']] }
  fonts: new Map(),  // page → promesse de chargement de la police
  flip: null,        // livre (bibliothèque page-flip)
  pages: [],         // numéros des pages du livre, dans l'ordre de lecture
  onFlip: null,      // appelé avec le numéro de la page affichée
};

const mushafPageData = (n) => {
  if (!mushaf.data.has(n)) mushaf.data.set(n, fetch(`data/pages/${pad3(n)}.json`).then((r) => r.json()));
  return mushaf.data.get(n);
};

const mushafFont = (n) => {
  if (!mushaf.fonts.has(n)) {
    const f = new FontFace(`qpc${n}`, `url(${MUSHAF_FONT(n)})`);
    mushaf.fonts.set(n, f.load().then((ff) => { document.fonts.add(ff); }).catch(() => {}));
  }
  return mushaf.fonts.get(n);
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
  page.className = 'mpage';
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
      row.innerHTML = `<span>سورة ${QURAN[h[2] - 1].name}</span>`;
    } else if (h && h[1] === 'B') {
      row.className = 'mline basm';
      row.textContent = BASMALA;
    } else {
      row.className = 'mline words';
      for (const [, glyph, s, a, pos] of byLine[l] || []) {
        const span = document.createElement('span');
        span.className = 'mw' + (pos ? '' : ' end') + (inSel(s, a) ? '' : ' out');
        span.style.fontFamily = `qpc${n}`;
        span.textContent = glyph;
        span.dataset.k = `${s}:${a}`;
        if (pos) span.dataset.w = `${s}:${a}:${pos}`;
        if (pos === 1) {
          const mark = hizbMark(s, a);
          if (mark) {
            const m = document.createElement('span');
            m.className = 'hmark';
            m.innerHTML = mark.map((t) => `<span>${t}</span>`).join('');
            row.appendChild(m);
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
}

// Ouvre le livre dans le conteneur host, sur les pages first … last.
async function openMushaf(host, first, last, inSel, startPage) {
  closeMushaf();
  mushaf.pages = [];
  for (let n = first; n <= last; n++) mushaf.pages.push(n);
  const datas = await Promise.all(mushaf.pages.map(mushafPageData));
  await Promise.all(mushaf.pages.map(mushafFont));
  host.innerHTML = '';
  const book = document.createElement('div');
  book.className = 'mbook';
  host.appendChild(book);
  const W = host.clientWidth, H = host.clientHeight;
  const els = mushaf.pages.map((n, i) => buildMushafPage(n, datas[i], inSel));
  // la bibliothèque tourne les pages comme un livre latin : on inverse l'ordre pour qu'un
  // glissement de gauche à droite mène à la page suivante (livre arabe)
  const reversed = els.slice().reverse();
  reversed.forEach((el) => { el.style.width = W + 'px'; el.style.height = H + 'px'; book.appendChild(el); });
  els.forEach(fitMushafPage);
  const idx = (n) => mushaf.pages.length - 1 - mushaf.pages.indexOf(n);
  mushaf.flip = new St.PageFlip(book, {
    width: W, height: H, size: 'fixed', usePortrait: true, showCover: false,
    drawShadow: true, maxShadowOpacity: 0.35, flippingTime: 700,
    mobileScrollSupport: false, swipeDistance: 25, clickEventForward: true,
    disableFlipByClick: true, showPageCorners: false,
    startPage: idx(startPage && mushaf.pages.includes(startPage) ? startPage : first),
  });
  mushaf.flip.loadFromHTML(reversed);
  mushaf.flip.on('flip', (e) => { if (mushaf.onFlip) mushaf.onFlip(mushaf.pages[mushaf.pages.length - 1 - e.data]); });
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
