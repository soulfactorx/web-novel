import { decodeText, decryptText, isEncrypted, WrongPasswordError } from './wncrypt.js';

const $ = (id) => document.getElementById(id);
const PAGE_CHARS = 15000;   // 한 페이지 최대 글자 수 (화 단위로 먼저 나눈다)
const MIN_CHAPTER = 1500;   // 이보다 짧으면 화 제목에서 페이지를 나누지 않음
const MAX_TABS = 8;
const MAX_CACHED_DOCS = 4;
const HEADING = /^\s*(?:(?:제\s*)?\d+\s*(?:화|장|권|부|편|회)(?:[\s.:\-)]|$)|(?:chapter|ep\.?|episode)\s*\d+|프롤로그|에필로그|외전|서장|종장|[#＃]\s*\d+|<\s*\d+\s*화?\s*>|\[\s*\d+\s*화?\s*\])/i;

const DEFAULTS = { fontSize: 18, lineHeight: 1.8, width: 720, paraGap: 0.6, font: 'serif', theme: 'auto' };
const LIMITS = { fontSize: [12, 32], lineHeight: [1.2, 2.6], width: [360, 1200], paraGap: [0, 2] };

// ---------- 저장소 ----------
const store = {
  get(key, def, area = localStorage) {
    try { const v = area.getItem('wn:' + key); return v ? JSON.parse(v) : def; } catch { return def; }
  },
  set(key, val, area = localStorage) {
    try { area.setItem('wn:' + key, JSON.stringify(val)); } catch { /* 저장 불가 환경은 무시 */ }
  },
};

let manifest = null;
let progress = store.get('progress', {});
let tabs = store.get('tabs', []);
let settings = { ...DEFAULTS, ...store.get('settings', {}) };
const docs = new Map();      // path → 파싱된 문서 (최근 사용 순)
let cur = null;              // { path, doc, page }
let restoring = false;

// ---------- 유틸 ----------
const titleOf = (path) => path.split('/').pop().replace(/\.enc$/i, '').replace(/\.txt$/i, '');
const fileUrl = (path) => path.split('/').map(encodeURIComponent).join('/');
const readHash = (path) => '#/read/' + encodeURIComponent(path);
const fmtPct = (r) => (r * 100).toFixed(r >= 0.995 && r < 1 ? 1 : 0) + '%';
function fmtSize(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
}
function fmtAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return '방금';
  if (s < 3600) return Math.floor(s / 60) + '분 전';
  if (s < 86400) return Math.floor(s / 3600) + '시간 전';
  if (s < 86400 * 30) return Math.floor(s / 86400) + '일 전';
  return new Date(t).toLocaleDateString('ko-KR');
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter((k) => k != null));
  return e;
}
function showView(id) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
}
function showMessage(text) {
  $('message').textContent = text;
  showView('message');
}

// ---------- 설정 ----------
function applySettings() {
  const r = document.documentElement;
  r.style.setProperty('--font-size', settings.fontSize + 'px');
  r.style.setProperty('--line-height', settings.lineHeight);
  r.style.setProperty('--width', settings.width + 'px');
  r.style.setProperty('--para-gap', settings.paraGap + 'em');
  r.dataset.theme = settings.theme;
  r.dataset.font = settings.font;
  $('v-fontSize').textContent = settings.fontSize;
  $('v-lineHeight').textContent = settings.lineHeight.toFixed(1);
  $('v-width').textContent = settings.width;
  $('v-paraGap').textContent = settings.paraGap.toFixed(1);
  $('s-font').value = settings.font;
  $('s-theme').value = settings.theme;
}
function changeSettings(patch) {
  const off = cur && !$('reader').hidden ? visibleOffset() : null;
  Object.assign(settings, patch);
  store.set('settings', settings);
  applySettings();
  if (off != null) scrollToOffset(off, false);
}

// ---------- 문서 파싱 ----------
function parseDoc(path, raw) {
  const text = raw.replace(/\r\n?/g, '\n');
  const lines = [];
  const toc = [];
  let o = 0;
  for (const s of text.split('\n')) {
    const heading = s.length <= 50 && HEADING.test(s);
    if (heading) toc.push({ line: lines.length, title: s.trim() });
    lines.push({ o, s, heading });
    o += s.length + 1;
  }
  // 페이지 나누기: 화 제목 앞에서 우선 나누고, 너무 길면 줄 경계에서 나눈다
  const pages = [];
  let start = 0;
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].heading && i > start && size >= MIN_CHAPTER) {
      pages.push({ from: start, to: i });
      start = i; size = 0;
    }
    size += lines[i].s.length + 1;
    if (size >= PAGE_CHARS) {
      pages.push({ from: start, to: i + 1 });
      start = i + 1; size = 0;
    }
  }
  if (start < lines.length || !pages.length) pages.push({ from: start, to: lines.length });
  for (const p of pages) {
    const first = lines.slice(p.from, p.to).find((l) => l.s.trim());
    p.label = first && first.heading ? first.s.trim() : '';
  }
  for (const t of toc) t.page = pageOfLine(pages, t.line);
  return { path, title: titleOf(path), length: text.length, lines, pages, toc };
}
function pageOfLine(pages, line) {
  let lo = 0, hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid].from <= line) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function lineOfOffset(doc, off) {
  let lo = 0, hi = doc.lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (doc.lines[mid].o <= off) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// ---------- 파일 불러오기 / 복호화 ----------
function savedPasswords() {
  const all = [...store.get('pw', [], sessionStorage), ...store.get('pw', [])];
  return [...new Set(all)];
}
function rememberPassword(pw, persist) {
  const put = (area) => store.set('pw', [pw, ...store.get('pw', [], area).filter((p) => p !== pw)].slice(0, 10), area);
  put(sessionStorage);
  if (persist) put(localStorage);
}
function askPassword(path, error) {
  return new Promise((resolve) => {
    const dlg = $('pw-dialog');
    $('pw-file').textContent = titleOf(path);
    $('pw-error').textContent = error || '';
    $('pw-input').value = '';
    dlg.onclose = () => resolve(dlg.returnValue === 'ok'
      ? { pw: $('pw-input').value, persist: $('pw-remember').checked } : null);
    dlg.returnValue = '';
    dlg.showModal();
    $('pw-input').focus();
  });
}
async function unlock(path, payload) {
  for (const pw of savedPasswords()) {
    try {
      const text = await decryptText(payload, pw);
      rememberPassword(pw, false);
      return text;
    } catch (e) { if (!(e instanceof WrongPasswordError)) throw e; }
  }
  let error = '';
  for (;;) {
    const ans = await askPassword(path, error);
    if (!ans) return null;
    showMessage('복호화하는 중…');
    try {
      const text = await decryptText(payload, ans.pw);
      rememberPassword(ans.pw, ans.persist);
      return text;
    } catch (e) {
      if (!(e instanceof WrongPasswordError)) throw e;
      error = e.message;
    }
  }
}
async function loadDoc(path) {
  if (docs.has(path)) {
    const d = docs.get(path);
    docs.delete(path); docs.set(path, d);
    return d;
  }
  showMessage('불러오는 중…');
  const res = await fetch(fileUrl(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`파일을 불러오지 못했습니다 (${res.status}): ${path}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let text;
  if (/\.enc$/i.test(path) || isEncrypted(bytes)) {
    text = await unlock(path, new TextDecoder().decode(bytes));
    if (text == null) return null;
  } else {
    text = decodeText(bytes);
  }
  const doc = parseDoc(path, text);
  docs.set(path, doc);
  while (docs.size > MAX_CACHED_DOCS) docs.delete(docs.keys().next().value);
  return doc;
}

// ---------- 탭 ----------
function renderTabs() {
  const nav = $('tabs');
  nav.replaceChildren(...tabs.map((path) => el('div', { class: 'tab' + (cur && cur.path === path ? ' active' : '') },
    el('a', { href: readHash(path), title: path }, titleOf(path)),
    el('button', { title: '닫기', 'aria-label': '탭 닫기', onclick: () => closeTab(path) }, '✕'),
  )));
  nav.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function addTab(path) {
  if (!tabs.includes(path)) tabs.push(path);
  while (tabs.length > MAX_TABS) tabs.splice(tabs.findIndex((p) => p !== path), 1);
  store.set('tabs', tabs);
}
function closeTab(path) {
  const i = tabs.indexOf(path);
  if (i < 0) return;
  tabs.splice(i, 1);
  store.set('tabs', tabs);
  if (cur && cur.path === path) {
    const next = tabs[i] || tabs[i - 1];
    location.hash = next ? readHash(next) : '#/';
  } else {
    renderTabs();
  }
}

// ---------- 리더 ----------
const content = $('content');
const topOffset = () => document.querySelector('.topbar').offsetHeight + 4;

function renderPage(pageIdx) {
  const { doc } = cur;
  cur.page = pageIdx;
  const page = doc.pages[pageIdx];
  const frag = document.createDocumentFragment();
  let prevBlank = true;
  for (let i = page.from; i < page.to; i++) {
    const line = doc.lines[i];
    const blank = !line.s.trim();
    if (blank && prevBlank) continue;
    prevBlank = blank;
    const p = document.createElement('p');
    p.dataset.o = line.o;
    if (blank) p.className = 'blank';
    else {
      if (line.heading) p.className = 'heading';
      p.textContent = line.s;
    }
    frag.append(p);
  }
  content.replaceChildren(frag);
  renderPager();
}
function renderPager() {
  const { doc, page } = cur;
  for (const id of ['pager-top', 'pager-bottom']) {
    const sel = el('select', { 'aria-label': '페이지 이동', onchange: (e) => goPage(+e.target.value) });
    doc.pages.forEach((p, i) => sel.append(new Option(`${i + 1} / ${doc.pages.length}${p.label ? ' · ' + p.label : ''}`, i)));
    sel.value = page;
    $(id).replaceChildren(
      el('button', { onclick: () => goPage(page - 1), ...(page === 0 ? { disabled: '' } : {}) }, '← 이전'),
      sel,
      el('button', { onclick: () => goPage(page + 1), ...(page === doc.pages.length - 1 ? { disabled: '' } : {}) }, '다음 →'),
    );
  }
}
function goPage(i, lineIdx) {
  if (!cur || i < 0 || i >= cur.doc.pages.length) return;
  restoring = true;
  renderPage(i);
  if (lineIdx != null) scrollToOffset(cur.doc.lines[lineIdx].o, true);
  else { window.scrollTo(0, 0); afterScroll(); }
}
function scrollToOffset(off, highlight) {
  restoring = true;
  const { doc } = cur;
  const page = pageOfLine(doc.pages, lineOfOffset(doc, off));
  if (page !== cur.page) renderPage(page);
  const ps = content.children;
  let target = ps[0];
  for (const p of ps) { if (+p.dataset.o <= off) target = p; else break; }
  if (target) {
    window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - topOffset());
    if (highlight && target.textContent) {
      target.classList.add('resume');
      setTimeout(() => target.classList.remove('resume'), 1500);
    }
  }
  afterScroll();
}
function afterScroll() {
  requestAnimationFrame(() => requestAnimationFrame(() => { restoring = false; saveProgress(); }));
}
// 화면 맨 위에 보이는 문단의 원문 위치(글자 오프셋)
function visibleOffset() {
  const ps = content.children;
  if (!ps.length) return cur.doc.pages[cur.page] ? cur.doc.lines[cur.doc.pages[cur.page].from].o : 0;
  const top = topOffset();
  let lo = 0, hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ps[mid].getBoundingClientRect().bottom > top + 2) hi = mid; else lo = mid + 1;
  }
  return +ps[lo].dataset.o;
}
function saveProgress() {
  if (!cur || restoring || $('reader').hidden) return;
  const { doc, path } = cur;
  const offset = visibleOffset();
  const atEnd = cur.page === doc.pages.length - 1
    && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
  const percent = atEnd ? 1 : Math.min(offset / Math.max(1, doc.length), 0.999);
  progress[path] = { offset, percent, title: doc.title, t: Date.now() };
  store.set('progress', progress);
  $('progress-text').textContent = fmtPct(percent);
  $('progress-line').style.width = percent * 100 + '%';
  const tocCur = curTocIndex(offset);
  for (const a of $('toc').querySelectorAll('a')) a.classList.toggle('current', +a.dataset.i === tocCur);
}
function curTocIndex(offset) {
  const { doc } = cur;
  if (!doc.toc.length) return cur.page;
  const line = lineOfOffset(doc, offset);
  let idx = -1;
  for (let i = 0; i < doc.toc.length && doc.toc[i].line <= line; i++) idx = i;
  return idx;
}
function renderToc() {
  const { doc } = cur;
  const items = doc.toc.length
    ? doc.toc.map((t) => ({ label: t.title, page: t.page, line: t.line }))
    : doc.pages.map((p, i) => ({ label: `${i + 1}쪽`, page: i, line: p.from }));
  $('toc').replaceChildren(...items.map((it, i) => el('li', {},
    el('a', { href: '#', 'data-i': i, onclick: (e) => { e.preventDefault(); closePanels(); goPage(it.page, it.line); } }, it.label))));
}

async function openReader(path) {
  let doc;
  try {
    doc = await loadDoc(path);
  } catch (e) {
    showMessage(e.message);
    return;
  }
  if (!doc) { // 비밀번호 입력 취소
    if (cur && cur.path !== path) location.replace(readHash(cur.path));
    else { closeTab(path); if (location.hash !== '#/') location.replace('#/'); }
    return;
  }
  cur = { path, doc, page: -1 };
  addTab(path);
  renderTabs();
  document.title = doc.title + ' - 웹소설 리더';
  $('doc-title').textContent = doc.title;
  $('btn-toc').textContent = doc.toc.length ? `☰ 목차 (${doc.toc.length})` : '☰ 페이지';
  renderToc();
  showView('reader');
  const saved = progress[path];
  if (saved) scrollToOffset(Math.min(saved.offset, doc.length), true);
  else goPage(0);
}

// ---------- 서재 ----------
function itemLink(path, title, metaText) {
  const pr = progress[path];
  return el('li', {}, el('a', { href: readHash(path) },
    el('span', {}, title),
    el('span', { class: 'meta' }, [metaText, pr && `${fmtPct(pr.percent)} · ${fmtAgo(pr.t)}`].filter(Boolean).join(' · ')),
    pr ? el('div', { class: 'bar' }, el('div', { style: `width:${pr.percent * 100}%` })) : null,
  ));
}
function renderLibrary() {
  cur = null;
  renderTabs();
  document.title = '웹소설 리더';
  $('progress-line').style.width = '0';
  showView('library');
  const files = manifest ? manifest.files : [];
  const known = new Set(files.map((f) => f.path));

  const recent = Object.entries(progress)
    .filter(([p]) => !manifest || known.has(p))
    .sort((a, b) => b[1].t - a[1].t).slice(0, 8);
  $('recent-section').hidden = !recent.length;
  $('recent').replaceChildren(...recent.map(([p, pr]) => itemLink(p, pr.title || titleOf(p), p.split('/').slice(1, -1).join(' / '))));

  const box = $('all');
  if (!manifest) {
    box.replaceChildren(el('p', { class: 'meta' },
      '소설 목록(novels/index.json)을 불러오지 못했습니다. GitHub Actions 배포가 끝났는지 확인하거나, 로컬이라면 node tools/build-index.mjs 를 실행하세요.'));
    return;
  }
  const q = $('search').value.trim().toLowerCase();
  const shown = files.filter((f) => !q || f.path.toLowerCase().includes(q));
  if (!shown.length) {
    box.replaceChildren(el('p', { class: 'meta' }, files.length ? '검색 결과가 없습니다.' : 'novels/ 폴더에 .txt 파일을 올리면 여기에 표시됩니다.'));
    return;
  }
  const groups = new Map();
  for (const f of shown) {
    if (!groups.has(f.folder)) groups.set(f.folder, []);
    groups.get(f.folder).push(f);
  }
  const collapsed = store.get('collapsed', {});
  box.replaceChildren(...[...groups].map(([folder, list]) => {
    const ul = el('ul', { class: 'list' }, ...list.map((f) => itemLink(f.path, f.title, (f.encrypted ? '🔒 ' : '') + fmtSize(f.size))));
    if (!folder) return ul;
    const det = el('details', { class: 'folder', ...(collapsed[folder] && !q ? {} : { open: '' }) },
      el('summary', {}, `📁 ${folder} (${list.length})`), ul);
    det.addEventListener('toggle', () => {
      const c = store.get('collapsed', {});
      if (det.open) delete c[folder]; else c[folder] = true;
      store.set('collapsed', c);
    });
    return det;
  }));
}
async function loadManifest() {
  try {
    const res = await fetch('novels/index.json', { cache: 'no-cache' });
    if (res.ok) manifest = await res.json();
  } catch { /* 목록 없이도 이어 읽기는 동작 */ }
}

// ---------- 라우팅 ----------
function route() {
  saveProgress();
  closePanels();
  const m = location.hash.match(/^#\/read\/(.+)$/);
  if (m) {
    const path = decodeURIComponent(m[1]);
    if (cur && cur.path === path && !$('reader').hidden) return;
    openReader(path);
  } else {
    renderLibrary();
  }
}

// ---------- 패널 / 이벤트 ----------
function closePanels() {
  $('toc-panel').hidden = true;
  $('settings-panel').hidden = true;
}
function togglePanel(id) {
  const open = $(id).hidden;
  closePanels();
  $(id).hidden = !open;
}

$('btn-toc').addEventListener('click', (e) => {
  e.stopPropagation();
  togglePanel('toc-panel');
  $('toc').querySelector('.current')?.scrollIntoView({ block: 'center' });
});
$('btn-settings').addEventListener('click', (e) => { e.stopPropagation(); togglePanel('settings-panel'); });
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closePanels);
document.addEventListener('click', (e) => {
  if (!e.target.closest('.panel') && !e.target.closest('dialog')) closePanels();
});
for (const b of document.querySelectorAll('[data-set]')) {
  b.addEventListener('click', () => {
    const key = b.dataset.set;
    const [min, max] = LIMITS[key];
    const v = Math.round((settings[key] + +b.dataset.step) * 10) / 10;
    changeSettings({ [key]: Math.min(max, Math.max(min, v)) });
  });
}
$('s-font').addEventListener('change', (e) => changeSettings({ font: e.target.value }));
$('s-theme').addEventListener('change', (e) => changeSettings({ theme: e.target.value }));
$('search').addEventListener('input', renderLibrary);

$('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ progress, tabs, settings }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `web-novel-progress-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    for (const [p, pr] of Object.entries(data.progress || {})) {
      if (!progress[p] || progress[p].t < pr.t) progress[p] = pr;
    }
    store.set('progress', progress);
    if (data.settings) changeSettings(data.settings);
    alert('읽기 기록을 가져왔습니다.');
    if (cur) scrollToOffset(progress[cur.path].offset, true); else renderLibrary();
  } catch {
    alert('올바른 기록 파일이 아닙니다.');
  }
});
$('btn-forget').addEventListener('click', () => {
  sessionStorage.removeItem('wn:pw');
  localStorage.removeItem('wn:pw');
  alert('저장된 비밀번호를 모두 지웠습니다.');
});

let scrollTimer = 0;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(saveProgress, 200);
}, { passive: true });
window.addEventListener('pagehide', saveProgress);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
window.addEventListener('storage', (e) => { // 다른 탭/창에서 읽은 기록 반영
  if (e.key === 'wn:progress') progress = store.get('progress', {});
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePanels();
  if (!cur || $('reader').hidden || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.target.closest('input, select, textarea, dialog')) return;
  if (e.key === 'ArrowLeft') goPage(cur.page - 1);
  else if (e.key === 'ArrowRight') goPage(cur.page + 1);
});
window.addEventListener('hashchange', route);

history.scrollRestoration = 'manual';
applySettings();
await loadManifest();
route();
