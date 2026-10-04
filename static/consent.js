// Cookie-согласие: игривая точка-печенька + модалка.
// Классический баннер — фолбэк для reduced-motion / выключенной анимации.
(() => {
  const CONSENT_KEY = 'pfp-consent';
  const PD_KEY = 'pfp-pd-consent';

  function showBanner(id, key) {
    const el = document.getElementById(id);
    if (!el) return;
    if (localStorage.getItem(key)) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';
    el.querySelector('button').addEventListener('click', () => {
      localStorage.setItem(key, new Date().toISOString());
      el.style.display = 'none';
    });
  }

  showBanner('pd-banner', PD_KEY);
  if (localStorage.getItem(CONSENT_KEY)) return;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const off = localStorage.getItem('pfp-particles-off') === '1';
  if (reduced || off) {
    showBanner('cookie-banner', CONSENT_KEY);
    return;
  }
  dotMode();

  function dotMode() {
    const dot = document.getElementById('cookie-dot');
    const modal = document.getElementById('cookie-modal');
    const acceptBtn = document.getElementById('cookie-accept');
    if (!dot || !modal || !acceptBtn) {
      showBanner('cookie-banner', CONSENT_KEY);
      return;
    }
    dot.hidden = false;
    // Дрейф к курсору, но на орбите 70px рядом — не перекрывать то, куда кликают
    let mx = innerWidth - 140, my = innerHeight - 180;
    let x = mx, y = my, ang = 0, open = false, raf = 0;
    addEventListener('pointermove', (e) => { mx = e.clientX; my = e.clientY; }, { passive: true });
    function tick() {
      if (open) return;
      ang += 0.02;
      const tx = mx + Math.cos(ang) * 70, ty = my + Math.sin(ang) * 70 - 20;
      // Рядом с курсором — ползём, чтобы точку можно было поймать кликом
      const near = Math.hypot(mx - x, my - y) < 90;
      const k = near ? 0.008 : 0.06;
      x += (tx - x) * k;
      y += (ty - y) * k;
      x = Math.max(30, Math.min(innerWidth - 30, x));
      y = Math.max(30, Math.min(innerHeight - 30, y));
      dot.style.transform = `translate(${x - 22}px, ${y - 22}px)`;
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    dot.addEventListener('click', () => {
      open = true;
      modal.hidden = false;
      acceptBtn.focus();
    });
    function close(backToDot) {
      modal.hidden = true;
      if (backToDot) {
        open = false;
        raf = requestAnimationFrame(tick);
      }
    }
    // Кнопки «Закрыть» нет (только «Принять»); Esc/фон молча возвращают к точке
    modal.addEventListener('click', (e) => { if (e.target === modal) close(true); });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(true); });
    acceptBtn.addEventListener('click', () => {
      localStorage.setItem(CONSENT_KEY, new Date().toISOString());
      close(false);
      dot.hidden = true;
      cancelAnimationFrame(raf);
    });
  }
})();
