// Bootstrap и цикл кадра. Единственный модуль с таймерами и слушателями
// событий — всё остальное чистое и вызывается отсюда.
import * as THREE from 'three';
import {
  renderer, scene, camera, mouse, mTarget, setStatus, syncCameraAspect,
  getPR, stepPR,
} from './core.js';
import { uniforms, geo } from './hair.js';
import { sprayFast, sprayCloud, glitter, bubbles, water, foamRivulet, cutBits, steam } from './particles.js';
import { streams } from './particles.js';
import { mist } from './particles.js';
import { dirtRinse } from './particles.js';
import { gumPts } from './gum.js';
import {
  readStage, applyPhases, updateMouseGlow, setStrands, syncResolution,
  retargetStrands, perfT, successT0, drawn, strandCap,
} from './director.js';
import { MAX_STRANDS, SEG, GOV_MIN } from './config.js';

export const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const off = localStorage.getItem('pfp-particles-off') === '1';

// Governor: гистерезис по FPS + cooldown. Шаг вниз адаптивный: при ровно ±1
// нити путь от 1000 до GOV_MIN занимал ~32 минуты, а система «звенела» у
// нижней границы (срезали нить → fps перескочил за 30 → вернули → снова вниз).
// Вниз шагаем долями от текущего количества, вверх — по одной нити, там
// ложное срабатывание невозможно.
const FPS_TARGET = 60;
const FPS_TOL = 2;
const GOV_PERIOD = 1.0;
const COOLDOWN_MS = 800;

// Сглаженный прогресс сцены. k=5 — экспоненциальное сглаживание,
// независимое от частоты кадров (в отличие от фиксированного коэффициента).
// 3 — «тягучий люкс», 7 — резче.
const SCROLL_K = 5.0;

// Один кадр статичного режима: p применяется без сглаживания.
function renderStatic() {
  uniforms.uIntro.value = 1;
  setStrands(strandCap);
  const p = readStage();
  uniforms.uScroll.value = p;
  applyPhases(p, 0);
  uniforms.uTime.value = 2.0;
  updateMouseGlow();
  uniforms.uMouse.value.set(mouse.x, mouse.y);
  renderer.render(scene, camera);
}

// До старта цикла: uRes нужен первому же кадру, иначе расширение линий в
// clip-space делит на (1,1) и нити схлопываются в точку.
syncResolution(renderer.getPixelRatio());

if (reduced || off) {
  renderStatic();
  setStatus('Анимация выключена');
} else {
  let frames = 0;
  let fpsAcc = 0;
  let lastChange = 0;
  let prDown = 0;
  let prUp = 0;
  let last = performance.now();
  const t0 = last;
  let scrollSmooth = 0;
  // director запоминает момент салюта в шкале performance.now(), а t идёт от
  // t0. Чтобы привести одно к другому, вычитаем смещение эпох: t0 — это тот
  // самый performance.now() на старте сцены. Раньше эпохи просто смешивались,
  // и работало только потому, что салют случался скоро после загрузки.
  const EPOCH = t0 / 1000;

  function governor(fps, now) {
    if (now - lastChange < COOLDOWN_MS) return;
    // Цель 60fps (vsync): ниже TARGET-TOL срезаем, выше TARGET-0.5 возвращаем.
    // Порог возврата ниже 60, т.к. выше vsync fps физически не поднимается.
    // Антидёрганье PR: нити реагируют сразу, а резкость — только после 3
    // подряд плохих/хороших окон (~3с). Иначе fps на границе порога гоняет
    // pr 1.0↔1.25 туда-сюда и каждый кадр с разным скейлом.
    // Порядок: вниз — сначала нити, потом резкость; вверх — наоборот.
    if (fps < FPS_TARGET - FPS_TOL) {
      prDown++; prUp = 0;
      if (drawn > GOV_MIN) {
        setStrands(drawn - Math.max(1, drawn >> 5));
        lastChange = now;
        console.info(`[lock] fps=${fps.toFixed(1)} → нитей ${drawn}`);
      } else if (prDown >= 3 && stepPR(-1)) {
        prDown = 0;
        syncResolution(renderer.getPixelRatio());
        setStrands(drawn); // обновить строку статуса (там текущий pr)
        lastChange = now;
        console.info(`[lock] fps=${fps.toFixed(1)} → pr ${getPR()}`);
      }
    } else if (fps > FPS_TARGET - 0.5) {
      prUp++; prDown = 0;
      if (drawn < strandCap) {
        setStrands(drawn + 1);
        lastChange = now;
        console.info(`[lock] fps=${fps.toFixed(1)} → нитей ${drawn}`);
      } else if (prUp >= 3 && stepPR(1)) {
        prUp = 0;
        syncResolution(renderer.getPixelRatio());
        setStrands(drawn);
        lastChange = now;
        console.info(`[lock] fps=${fps.toFixed(1)} → pr ${getPR()}`);
      }
    } else {
      prDown = 0; prUp = 0;
    }
  }

  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    const t = (now - t0) / 1000;

    frames++;
    fpsAcc += dt;
    if (fpsAcc >= GOV_PERIOD) {
      const fps = frames / fpsAcc;
      frames = 0;
      fpsAcc = 0;
      governor(fps, now);
    }

    // Мышь: экспоненциальное сглаживание через dt. Фиксированный 0.09 означал,
    // что на 30 fps гало вел себя вдвое медленнее, чем на 60.
    const mk = 1 - Math.exp(-dt * 6.0);
    mouse.x += (mTarget.x - mouse.x) * mk;
    mouse.y += (mTarget.y - mouse.y) * mk;
    uniforms.uTime.value = t;
    uniforms.uMouse.value.set(mouse.x, mouse.y);
    // Вход на 20% медленнее базовых 3.4с: все нити падают разом (~4.1с).
    uniforms.uIntro.value = Math.min(t / 4.1, 1);
    // Сцена едет по сглаженному p, UI — по сырому (внутри readStage).
    const pRaw = readStage();
    scrollSmooth += (pRaw - scrollSmooth) * (1 - Math.exp(-dt * SCROLL_K));
    const p = scrollSmooth;
    uniforms.uScroll.value = p;
    applyPhases(p, t);
    updateMouseGlow();
    // Салют отсчитывается от момента входа на финальную стадию (см. director).
    const st = (t - (successT0 - EPOCH)) / 2.5;
    uniforms.uSuccess.value = st >= 0 && st <= 1 ? Math.sin(st * Math.PI) : 0;
    renderer.render(scene, camera);
  }

  setStrands(strandCap);
  requestAnimationFrame(loop);
}

// Resize держим ВНЕ ветки reduced/off. Раньше он был внутри else, поэтому при
// статичном кадре ресайз не обрабатывался вовсе: камера сохраняла аспект на
// момент загрузки, и кадр растягивался.
addEventListener('resize', () => {
  syncCameraAspect();
  renderer.setSize(innerWidth, innerHeight);
  retargetStrands();
  syncResolution(renderer.getPixelRatio());
  if (reduced || off) renderStatic();
}, { passive: true });

// Скролл в анимированном режиме обрабатывается loop'ом каждый кадр, поэтому
// хендлер нужен только для статичного кадра, где loop не идёт.
addEventListener('scroll', () => {
  if (!reduced && !off) return;
  renderStatic();
}, { passive: true });

syncResolution(renderer.getPixelRatio());

// Кнопка «Анимация». Обработчик раньше жил в particles.js, но тот файл выходил
// на строке `if (!canvas) return;` — canvas #particles в шаблонах давно нет,
// поэтому до обработчика дело не доходило и кнопка была мёртвой.
(() => {
  const btn = document.getElementById('particles-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const nowOff = localStorage.getItem('pfp-particles-off') === '1';
    localStorage.setItem('pfp-particles-off', nowOff ? '0' : '1');
    // Полная перезагрузка — единственный честный способ переключить режим:
    // нужно пересобрать ветку reduced/off, слои частиц и governor, а не гасить
    // уже запущенный requestAnimationFrame наполовину.
    location.reload();
  });
})();

// ---- Отладочный доступ из консоли и тестов --------------------------------
window.__pfpLock = {
  uniforms, renderer, geo, camera,
  get strands() { return drawn; },
  get maxStrands() { return MAX_STRANDS; },
  get triangles() { return drawn * SEG * 2; },
  get strandCap() { return strandCap; },
  setStrands,
  // Слои частиц: uWash/uSteam/uCut живут в материалах систем, а не в общих
  // uniform'ах, и без доступа к ним их не проверить из консоли.
  sprayFast, sprayCloud, glitter, bubbles, water, foamRivulet, cutBits, steam,
  streams, gumPts,
  mist, dirtRinse,
  get spray() {
    return [sprayFast, sprayCloud].map((p) => ({
      visible: p.visible,
      lacquer: +p.material.uniforms.uLacquer.value.toFixed(3),
      nozzle: p.material.uniforms.uNozzle.value.toArray().map((v) => +v.toFixed(2)),
      dir: p.material.uniforms.uDir.value.toArray().map((v) => +v.toFixed(2)),
    }));
  },
};
