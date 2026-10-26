import { decodeText, decryptText, decryptBytes, isEncrypted, WrongPasswordError } from './wncrypt.js';
import config from './config.js';
import { initProtect } from './protect.js';

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
let pendingNav = null;        // 이전/다음 화 이동: { path, from }

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
function addTab(path, replace) {
  const at = tabs.indexOf(replace);
  if (tabs.includes(path)) { if (at >= 0 && replace !== path) tabs.splice(at, 1); }
  else if (at >= 0) tabs[at] = path; // 이전/다음 화로 넘어가면 같은 탭을 이어 쓴다
  else tabs.push(path);
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
  const cover = pageIdx === 0 && coverOf(cur.path);
  $('doc-cover').replaceChildren(cover ? coverEl(cover, doc.title, 'large') : '');
  $('doc-cover').hidden = !cover;
  renderPager();
}
function renderPager() {
  const { doc, page } = cur;
  for (const id of ['pager-top', 'pager-bottom']) {
    const sel = el('select', { 'aria-label': '페이지 이동', onchange: (e) => goPage(+e.target.value) });
    doc.pages.forEach((p, i) => sel.append(new Option(`${i + 1} / ${doc.pages.length}${p.label ? ' · ' + p.label : ''}`, i)));
    sel.value = page;
    const prevFile = page === 0 && sibling(-1);
    const nextFile = page === doc.pages.length - 1 && sibling(1);
    $(id).replaceChildren(
      el('button', { onclick: () => step(-1), title: prevFile ? prevFile.title : '',
        ...(page === 0 && !prevFile ? { disabled: '' } : {}) }, prevFile ? '← 이전 화' : '← 이전'),
      sel,
      el('button', { onclick: () => step(1), title: nextFile ? nextFile.title : '',
        ...(page === doc.pages.length - 1 && !nextFile ? { disabled: '' } : {}) }, nextFile ? '다음 화 →' : '다음 →'),
    );
  }
}
// 같은 폴더에서 앞(-1)/뒤(1) 파일
function sibling(dir) {
  if (!manifest || !cur) return null;
  const me = manifest.files.find((f) => f.path === cur.path);
  if (!me) return null;
  const list = manifest.files.filter((f) => f.folder === me.folder);
  return list[list.indexOf(me) + dir] || null;
}
// 페이지 이동, 파일의 처음/끝이면 이전/다음 화로
function step(dir) {
  if (!cur) return;
  const i = cur.page + dir;
  if (i >= 0 && i < cur.doc.pages.length) { goPage(i); return; }
  const f = sibling(dir);
  if (!f) return;
  if (dir > 0) { // 다음 화로 넘어가면 지금 화는 다 읽은 것으로 기록
    progress[cur.path] = { ...progress[cur.path], offset: cur.doc.length, percent: 1, title: cur.doc.title, t: Date.now() };
    store.set('progress', progress);
  }
  pendingNav = { path: f.path, from: cur.path };
  location.hash = readHash(f.path);
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
  const nav = pendingNav && pendingNav.path === path ? pendingNav : null;
  pendingNav = null;
  addTab(path, nav?.from);
  renderTabs();
  document.title = doc.title + ' - 웹소설 리더';
  $('doc-title').textContent = doc.title;
  const folder = manifest?.files.find((f) => f.path === path)?.folder;
  $('doc-title').href = folder && manifest.files.filter((f) => f.folder === folder).length > 1 ? workHash(folder) : '#/';
  $('btn-toc').textContent = doc.toc.length ? `☰ 목차 (${doc.toc.length})` : '☰ 페이지';
  renderToc();
  showView('reader');
  const saved = progress[path];
  if (nav) goPage(0); // 이전/다음 화로 넘어오면 처음부터
  else if (saved) scrollToOffset(Math.min(saved.offset, doc.length), true);
  else goPage(0);
}

// ---------- 표지 ----------
const coverCache = new Map(); // 경로 → Promise<objectURL | null>
function coverOf(path) {
  if (!manifest) return null;
  const f = manifest.files.find((x) => x.path === path);
  return f ? f.cover || (manifest.folderCovers || {})[f.folder] || null : null;
}
function loadCover(path) {
  if (!coverCache.has(path)) {
    coverCache.set(path, (async () => {
      const res = await fetch(fileUrl(path));
      if (!res.ok) return null;
      if (!/\.enc$/i.test(path)) return URL.createObjectURL(await res.blob());
      // 암호화된 표지는 이미 입력한(저장된) 비밀번호로만 조용히 시도한다
      const payload = await res.text();
      for (const pw of savedPasswords()) {
        try {
          const { bytes, type } = await decryptBytes(payload, pw);
          return URL.createObjectURL(new Blob([bytes], { type }));
        } catch (e) { if (!(e instanceof WrongPasswordError)) return null; }
      }
      coverCache.delete(path); // 나중에 비밀번호를 입력하면 다시 시도
      return null;
    })().catch(() => null));
  }
  return coverCache.get(path);
}
// 표지 이미지(없으면 제목으로 만든 기본 표지)
function coverEl(path, title, cls = '') {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.codePointAt(0)) % 360;
  const box = el('div', { class: 'cover ' + cls, style: `--h:${h}` },
    el('span', { class: 'cover-title' }, title));
  if (path) {
    if (/\.enc$/i.test(path)) box.append(el('span', { class: 'cover-lock', title: '암호화된 표지' }, '🔒'));
    loadCover(path).then((url) => {
      if (!url) return;
      const img = el('img', { alt: '', src: url });
      img.onload = () => { box.classList.add('has-img'); box.replaceChildren(img); };
    });
  }
  return box;
}

// ---------- 서재 ----------
const workHash = (folder) => '#/work/' + encodeURIComponent(folder);
function itemLink(path, title, metaText, cover) {
  const pr = progress[path];
  return el('li', {}, el('a', { href: readHash(path) },
    cover !== undefined ? coverEl(cover, title, 'thumb') : null,
    el('div', { class: 'info' },
      el('span', {}, title),
      el('span', { class: 'meta' }, [metaText, pr && `${fmtPct(pr.percent)} · ${fmtAgo(pr.t)}`].filter(Boolean).join(' · ')),
      pr ? el('div', { class: 'bar' }, el('div', { style: `width:${pr.percent * 100}%` })) : null),
  ));
}
// 작품 = 폴더 하나 (최상위에 바로 있는 파일은 각각 한 작품)
function worksOf(files) {
  const works = new Map();
  for (const f of files) {
    const key = f.folder || '/' + f.path;
    if (!works.has(key)) works.set(key, { folder: f.folder, title: f.folder ? f.folder.split('/').pop() : f.title, files: [] });
    works.get(key).files.push(f);
  }
  for (const w of works.values()) {
    w.cover = (w.folder && (manifest.folderCovers || {})[w.folder]) || w.files.find((f) => f.cover)?.cover || null;
    w.last = w.files.map((f) => progress[f.path] && { f, ...progress[f.path] }).filter(Boolean).sort((a, b) => b.t - a.t)[0];
  }
  return [...works.values()];
}
function workCard(w) {
  const single = w.files.length === 1;
  const href = single ? readHash(w.files[0].path) : workHash(w.folder);
  const meta = [single ? fmtSize(w.files[0].size) : `${w.files.length}개 파일`];
  if (w.files.some((f) => f.encrypted)) meta.unshift('🔒');
  if (w.last) meta.push(fmtPct(w.last.percent));
  return el('a', { class: 'card', href, title: w.folder || w.files[0].path },
    coverEl(w.cover, w.title),
    el('span', { class: 'card-title' }, w.title),
    el('span', { class: 'meta' }, meta.join(' · ')),
    w.last ? el('div', { class: 'bar' }, el('div', { style: `width:${w.last.percent * 100}%` })) : null);
}
function resetView(title) {
  cur = null;
  renderTabs();
  document.title = title;
  $('progress-line').style.width = '0';
}
function renderLibrary() {
  resetView('웹소설 리더');
  showView('library');
  const files = manifest ? manifest.files : [];
  const known = new Set(files.map((f) => f.path));

  const recent = Object.entries(progress)
    .filter(([p]) => !manifest || known.has(p))
    .sort((a, b) => b[1].t - a[1].t).slice(0, 8);
  $('recent-section').hidden = !recent.length;
  $('recent').replaceChildren(...recent.map(([p, pr]) =>
    itemLink(p, pr.title || titleOf(p), p.split('/').slice(1, -1).join(' / '), coverOf(p))));

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
  box.replaceChildren(el('div', { class: 'grid' }, ...worksOf(shown).map(workCard)));
}
function renderWork(folder) {
  const list = manifest ? manifest.files.filter((f) => f.folder === folder) : [];
  if (!list.length) { location.replace('#/'); return; }
  const [w] = worksOf(list);
  resetView(w.title + ' - 웹소설 리더');
  showView('work');
  const next = w.last ? w.last.f : list[0];
  $('work-head').replaceChildren(
    coverEl(w.cover, w.title, 'large'),
    el('div', { class: 'work-info' },
      el('a', { href: '#/', class: 'meta' }, '← 서재'),
      el('h2', {}, w.title),
      el('p', { class: 'meta' }, [folder.includes('/') ? folder : '', `${list.length}개 파일`].filter(Boolean).join(' · ')),
      el('a', { class: 'button primary', href: readHash(next.path) }, w.last ? `이어 읽기 · ${next.title}` : '처음부터 읽기')));
  // 파일마다 표지가 따로 있을 때만 목록에 작은 표지를 보여준다
  const perFile = list.some((f) => f.cover && f.cover !== w.cover);
  $('work-files').replaceChildren(...list.map((f) =>
    itemLink(f.path, f.title, (f.encrypted ? '🔒 ' : '') + fmtSize(f.size), perFile ? f.cover || w.cover : undefined)));
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
  const work = location.hash.match(/^#\/work\/(.+)$/);
  if (work) { renderWork(decodeURIComponent(work[1])); return; }
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
  if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
});
window.addEventListener('hashchange', route);

history.scrollRestoration = 'manual';
initProtect(config.protect);
applySettings();
await loadManifest();
route();
