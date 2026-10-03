// Cookie + ПД баннеры: показ при первом визите, запись согласия в localStorage
(() => {
  const CONSENT_KEY = 'pfp-consent';
  const PD_KEY = 'pfp-pd-consent';

  function showBanner(id, key, onAccept) {
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
      if (onAccept) onAccept();
    });
  }

  showBanner('cookie-banner', CONSENT_KEY);
  showBanner('pd-banner', PD_KEY);
})();
