// 리더 본문 복사·캡처 억제. 설정은 config.js 의 protect 항목.
const root = document.documentElement;
const inReader = () => !document.getElementById('reader').hidden;
// 비밀번호 입력창·검색창 같은 입력 요소에서는 평소처럼 동작하게 둔다
const inField = (t) => t instanceof Element && t.closest('input, textarea, select');

function shield(on) {
  root.classList.toggle('shielded', on && inReader());
}

export function initProtect(opts = {}) {
  if (opts.copy) {
    root.dataset.protect = '';
    for (const type of ['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart']) {
      document.addEventListener(type, (e) => {
        if (inReader() && !inField(e.target)) e.preventDefault();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (!inReader() || inField(e.target) || !(e.ctrlKey || e.metaKey)) return;
      if (['a', 'c', 'x', 's', 'p', 'u'].includes(e.key.toLowerCase())) e.preventDefault();
    });
    window.addEventListener('beforeprint', () => shield(true));
    window.addEventListener('afterprint', () => shield(false));
  }

  if (opts.blurOnLeave) {
    window.addEventListener('blur', () => shield(true));
    window.addEventListener('focus', () => shield(false));
    document.addEventListener('visibilitychange', () => shield(document.hidden));
    // 가린 상태에서 클릭하면 다시 보이게 (포커스 이벤트가 오지 않는 환경 대비)
    document.addEventListener('pointerdown', () => { if (document.hasFocus()) shield(false); });
  }

  if (opts.printScreen) {
    const onPrintScreen = (e) => {
      if (e.key !== 'PrintScreen' || !inReader()) return;
      shield(true);
      navigator.clipboard?.writeText('').catch(() => {});
      setTimeout(() => shield(!document.hasFocus()), 1500);
    };
    document.addEventListener('keydown', onPrintScreen);
    document.addEventListener('keyup', onPrintScreen);
  }

  if (opts.watermark) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="160">`
      + `<text x="130" y="80" text-anchor="middle" transform="rotate(-25 130 80)" `
      + `font-family="sans-serif" font-size="14" fill="#888" fill-opacity=".22">${opts.watermark
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></svg>`;
    root.style.setProperty('--watermark', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
    root.dataset.watermark = '';
  }
}
