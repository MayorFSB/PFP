// Частицы: Canvas 2D + шум Перлина + FPS-адаптация + кнопка отключения
// Вес ~8KB, работает на любом устройстве

(() => {
  const canvas = document.getElementById('particles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const disabled = localStorage.getItem('pfp-particles-off') === '1';
  if (reduced || disabled) return;

  let W, H, particles = [], raf = null, lastT = 0, fps = 60, frameCount = 0, fpsTime = 0;
  const BASE_COUNT = 900;
  let currentCount = BASE_COUNT;

  // Шум Перлина (упрощённый) — псевдохаотичное движение
  function noise(x, y, t) {
    return Math.sin(x * 0.008 + t) * Math.cos(y * 0.006 - t * 0.7) * 0.5 +
           Math.sin((x + y) * 0.004 + t * 0.3) * 0.3;
  }

  function resize() {
    W = canvas.width = canvas.offsetWidth;
    H = canvas.height = canvas.offsetHeight;
  }

  function initParticles() {
    particles = [];
    for (let i = 0; i < currentCount; i++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        seed: Math.random() * 1000,
        r: 1 + Math.random() * 1.5,
      });
    }
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    const time = t * 0.001;
    for (const p of particles) {
      const nx = noise(p.x, p.y, time + p.seed);
      const ny = noise(p.y, p.x, time * 0.8 + p.seed);
      p.x += nx * 0.6;
      p.y += ny * 0.6;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(232, 179, 75, 0.5)';
      ctx.fill();
    }
    // линии между близкими точками (геометрический минимализм)
    ctx.strokeStyle = 'rgba(232, 179, 75, 0.08)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < particles.length; i += 3) {
      for (let j = i + 3; j < Math.min(i + 12, particles.length); j += 3) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 10000) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }
    }
  }

  function loop(t) {
    if (!lastT) lastT = t;
    const dt = t - lastT;
    lastT = t;
    frameCount++;
    fpsTime += dt;
    if (fpsTime >= 2000) {
      fps = Math.round((frameCount * 1000) / fpsTime);
      frameCount = 0;
      fpsTime = 0;
      // FPS-адаптация: уменьшаем частицы при просадке
      if (fps < 25 && currentCount > 300) {
        currentCount = Math.max(300, Math.floor(currentCount * 0.6));
        initParticles();
      }
    }
    draw(t);
    raf = requestAnimationFrame(loop);
  }

  function start() {
    resize();
    initParticles();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, W, H);
  }

  // Кнопка отключения
  const btn = document.getElementById('particles-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      localStorage.setItem('pfp-particles-off', '1');
      stop();
      btn.textContent = 'Анимация выключена';
      btn.disabled = true;
    });
  }

  start();
})();
