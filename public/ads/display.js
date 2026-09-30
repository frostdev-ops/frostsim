/* Manual guide ads only. Never load Google's code in the isolated simulation workspace. */
(() => {
  const nonce = document.currentScript?.nonce;
  if (window.crossOriginIsolated || !location.pathname.startsWith('/guides/') || !nonce) return;
  let area;
  let script;
  let stopped = false;
  const clear = () => { stopped = true; area?.remove(); script?.remove(); };
  const config = async () => {
    const response = await fetch('/api/v1/ads', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Ad eligibility unavailable');
    return response.json();
  };
  const eligible = (value) => value.enabled === true && /^ca-pub-\d{16}$/.test(value.publisher) && /^\d{10}$/.test(value.slot);
  async function start() {
    try {
      if (!eligible(await config()) || stopped) return;
      const footer = document.querySelector('.page > footer');
      if (!footer) return;
      area = document.createElement('aside');
      area.className = 'fs-ad';
      area.setAttribute('aria-label', 'Advertisements');
      const label = document.createElement('p');
      label.textContent = 'Advertisements';
      area.append(label);
      footer.before(area);
      const observer = new IntersectionObserver(async (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        try {
          // Recheck immediately before any third-party code or ad request.
          const value = await config();
          if (!eligible(value) || stopped) return clear();
          const ad = document.createElement('ins');
          ad.className = 'adsbygoogle';
          ad.dataset.adClient = value.publisher;
          ad.dataset.adSlot = value.slot;
          ad.dataset.adFormat = 'horizontal';
          ad.dataset.fullWidthResponsive = 'false';
          area.append(ad);
          script = document.createElement('script');
          script.async = true;
          script.crossOrigin = 'anonymous';
          script.nonce = nonce;
          script.dataset.cfasync = 'false';
          script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${value.publisher}`;
          script.onerror = clear;
          script.onload = async () => {
            try {
              if (!eligible(await config()) || stopped) return clear();
              const privacy = document.createElement('button');
              privacy.type = 'button';
              privacy.textContent = 'Ad privacy settings';
              privacy.onclick = () => {
                if (!window.googlefc) return;
                (window.googlefc.callbackQueue = window.googlefc.callbackQueue || []).push({
                  CONSENT_API_READY: () => window.googlefc.showRevocationMessage(),
                });
              };
              area.append(privacy);
              (window.adsbygoogle = window.adsbygoogle || []).push({});
            } catch { clear(); }
          };
          document.head.append(script);
        } catch { clear(); }
      }, { rootMargin: '200px' });
      observer.observe(area);
    } catch { clear(); }
  }
  // A checkout or sign-in in another tab must be rechecked on return. No ad auto-refresh.
  const recheck = async () => {
    if (!area) return;
    try { if (!eligible(await config())) clear(); } catch { clear(); }
  };
  addEventListener('focus', recheck);
  addEventListener('storage', recheck);
  addEventListener('pageshow', recheck);
  void start();
})();
