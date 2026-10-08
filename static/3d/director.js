// Режиссёр: превращает скролл в состояние сцены.
//
// Три обязанности, и важно, что они РАЗНЫЕ:
//   readStage()   — определить стадию и вернуть СЫРОЙ p. Uniform'ы не пишет.
//   resetShared() — обнулить uniform'ы, в которые пишут несколько фаз.
//   applyPhases() — прогнать фазы 0…6 по порядку и применить цветокоррекцию.
//
// Разделение readStage/applyPhases существует из-за сглаживания скролла: раньше
// сетка сущностей считалась от сырого p, а шейдер — от сглаженного, и
// частицы мытья разъезжались с прядями. Теперь обе вещи читают одно число.
//
// ПОРЯДОК ФАЗ ИМЕЕТ ЗНАЧЕНИЕ: они вызываются строго 0…6, и поздняя может
// перекрыть раннюю. Поэтому uniform не должен принадлежать двум фазам; если
// принадлежит — он идёт через resetShared + вклад, а не через присваивание.
import * as THREE from 'three';
import { uniforms, geo, VPL } from './hair.js';
import { steam, washLayers, bundleLayers, sizedLayers, bubbles } from './particles.js';
import { mouse, mTarget, setStatus, halfViewW, getPR, camera } from './core.js';
import { syncGumSize } from './gum.js';
import { MAX_STRANDS, SEG, GOV_MIN, strandsForWidth, WIDTH_FRAC, BUNDLE_R, PHASE, TL, ACTIVE_PHASES } from './config.js';

import phase0 from './phases/phase0.js';
import phase1 from './phases/phase1.js';
import phase2 from './phases/phase2.js';
import phase3 from './phases/phase3.js';
import phase4 from './phases/phase4.js';
import phase5 from './phases/phase5.js';
import phase6 from './phases/phase6.js';

const ALL_PHASES = [phase0, phase1, phase2, phase3, phase4, phase5, phase6];
// Включены только фазы из ACTIVE_PHASES. Остальные импортированы (чтобы не
// потерять проводку), но не вызываются — сцена перманентна на фазе 0.
export const PHASES = ALL_PHASES.filter((ph) => ACTIVE_PHASES.includes(ph.id));

// Диапазоны ОБЯЗАНЫ быть идущими подряд без перекрытий: иначе p при переходе
// между секциями идёт назад и эффекты откатываются (ножницы возвращались из
// opacity 0). Поэтому сначала проверяем монотонность, потом сцена работает.
{
  const keys = [...document.querySelectorAll('[data-stage]')].map((el) => el.dataset.stage);
  let prevEnd = 0;
  let bad = '';
  for (const k of keys) {
    const r = PHASE[k];
    if (!r) { bad = `${k}: нет диапазона`; break; }
    if (Math.abs(r[0] - prevEnd) > 1e-6) { bad = `${k}: старт ${r[0]} ≠ предыдущий конец ${prevEnd}`; break; }
    prevEnd = r[1];
  }
  if (bad) console.error('[lock] разрывы в таблице стадий —', bad);
  else console.info('[lock] PHASE: таблица стадий непрерывна, стадий:', keys.length);
}

const stageEls = [...document.querySelectorAll('[data-stage]')];
let stageKey = 'intro';
let stageLocal = 0;
let navReady = false;
let saluted = false;
export let successT0 = -10;

export const perfT = () => performance.now() / 1000;
export const salute = () => { successT0 = perfT(); };
// Старый отладочный хук: внешний код (кнопка успеха) дёргает его, чтобы
// запустить салют. Оставляем имя, чтобы не чинить вызывающие места.
window.__pfpSalute = salute;

// Отладочное состояние стадии: то же, что было в монолите, чтобы старые
// консольные проверки (__pfpStage().stage / .scroll / .strands) работали.
window.__pfpStage = () => ({
  stage: stageKey,
  local: +stageLocal.toFixed(3),
  navReady,
  scroll: +uniforms.uScroll.value.toFixed(3),
  weave: +uniforms.uWeave.value.toFixed(3),
  strands: drawn,
  triangles: drawn * SEG * 2,
});

/**
 * Определяет стадию по секциям и возвращает сырой p.
 * Uniform'ы здесь НЕ пишутся: анимация едет по сглаженному значению,
 * UI-состояния (navReady, saluted) — по сырому, чтобы интерфейс не тормозил.
 */export function readStage() {
  let range = [0, 1];
  if (stageEls.length) {
    const mid = innerHeight * 0.5;
    let el = stageEls[0];
    let local = 0;
    for (const s of stageEls) {
      const r = s.getBoundingClientRect();
      if (r.top <= mid) {
        el = s;
        local = Math.min(Math.max((mid - r.top) / r.height, 0), 1);
      } else break;
    }
    if (stageEls[0].getBoundingClientRect().top > mid) local = 0;
    stageKey = el.dataset.stage;
    stageLocal = local;
    range = PHASE[stageKey] || range;
    const ready = stageEls.indexOf(el) >= 1;
    if (ready !== navReady) {
      navReady = ready;
      document.body.classList.toggle('nav-ready', ready);
    }
    if (stageKey === 'result' && !saluted) {
      saluted = true;
      salute();
    }
  }
  return range[0] + (range[1] - range[0]) * stageLocal;
}

/** Uniform'ы, в которые пишут несколько фаз: обнуляем перед проходом. */
function resetShared() {
  steam.material.uniforms.uSteam.value = 0;
}

/**
 * Единственное место, где p превращается в состояние сцены.
 * @param {number} p сглаженный прогресс 0..1
 * @param {number} t время сцены, секунды
 */
export function applyPhases(p, t) {
  resetShared();
  for (const ph of PHASES) ph.apply(p, t);
  steam.visible = steam.material.uniforms.uSteam.value > 0.01;
  applyGrade(p);
}

// Цветокоррекция: три якоря, линейное смешивание по сетке таймлайна.
// В конце нормируем по среднему каналу, иначе сумма множителей уезжает от 3
// и общая яркость кадра «плавает» при наложении якорей.
const GRADE_COOL = [-0.05, -0.01, 0.07];  // мытьё — холодный
const GRADE_WARM = [0.05, 0.00, -0.07];   // укладка — тёплый
const GRADE_GOLD = [0.06, 0.00, -0.10];   // финал — золотой
function applyGrade(p) {
  const S = THREE.MathUtils;
  // Холодный — ОКНО мытья, а не нарастающий фронт: с фронтом оттенок залипал на
  // всю оставшуюся страницу и укладка выглядела мокрой.
  const c = S.smoothstep(p, TL.washFx[0], TL.washFx[1])
    * (1 - S.smoothstep(p, TL.washFx[2], TL.washFx[3]));
  // Тёплый — нарастающий фронт укладки и держится до финала: волосы после
  // утюжка остаются тёплыми, это физично.
  const w = S.smoothstep(p, TL.wave[0], TL.wave[1]);
  const f = S.smoothstep(p, TL.finale[0], TL.finale[1]);
  const u = uniforms.uGrade.value;
  u.set(
    1 + GRADE_COOL[0] * c + GRADE_WARM[0] * w + GRADE_GOLD[0] * f,
    1 + GRADE_COOL[1] * c + GRADE_WARM[1] * w + GRADE_GOLD[1] * f,
    1 + GRADE_COOL[2] * c + GRADE_WARM[2] * w + GRADE_GOLD[2] * f,
  );
  const mean = (u.x + u.y + u.z) / 3;
  if (mean > 1e-4) u.multiplyScalar(1 / mean);
}

/** Гало под курсором включается только рядом с локоном (|x|<2.0, |y|<5.6),
 *  иначе подсветка неожиданно вспыхивала бы над текстом в боковых колонках. */
export function updateMouseGlow() {
  const inside = mTarget.x < 9000;
  const nearLock = Math.abs(mTarget.x) < 2.0 && Math.abs(mTarget.y) < 5.6;
  uniforms.uGlow.value = inside && nearLock ? 1 : 0;
}

// ---- Governor качества ---------------------------------------------------
export let drawn = MAX_STRANDS;
// Потолок нитей для текущей ширины окна. Governor работает только вниз от
// него, поэтому на широком экране сцена получает больше нитей, а на узком —
// меньше, и при этом FPS-страховка сохраняется.
export let strandCap = strandsForWidth(innerWidth);

export function setStrands(n) {
  drawn = Math.min(Math.max(n, GOV_MIN), strandCap);
  geo.setDrawRange(0, drawn * VPL);
  uniforms.uCount.value = drawn;
  // Слои мытья масштабируются тем же governor: иначе на слабой машине они
  // просадят FPS, governor срежет нити — и подмена бросится в глаза.
  for (const pts of washLayers()) {
    const total = pts.geometry.attributes.aDrop.count;
    pts.geometry.setDrawRange(0, Math.ceil(total * (drawn / MAX_STRANDS)));
  }
  setStatus(`3D: ${drawn} нитей · ${(drawn * SEG * 2 / 1000).toFixed(1)}k треугольников · pr${getPR()}`);
}

/**
 * Ширина локона и число нитей от ширины окна.
 *
 * Локон — world-геометрия, поэтому без этого он занимал фиксированную долю
 * кадра: на 1920px выглядел тонким, на 1280px — жирным. Считаем обратно:
 * нужная ширина пучка в world = WIDTH_FRAC * (2 * halfViewW), и отдаём
 * во uniform масштаб радиуса.
 *
 * Тот же расчёт отдаёт CSS-переменную --center в пикселях: боковые колонки
 * резервируют ровно столько, сколько занимает локон, поэтому текст не может
 * на него заехать. Раньше ширины задавались независимо (.stage 36%, шапка
 * 26%), и на 1024–1280 ссылки физически перекрывали пучок.
 *
 * Известное ограничение: uWidthK зажат сверху 2.6, поэтому на мониторах
 * шире ~1920px пучок занимает меньше WIDTH_FRAC (23.9% на 2560px вместо 34%).
 * Лечится снятием клампа, а не подбором WIDTH_FRAC.
 */
export function syncWidth() {
  const wantWorld = 2 * halfViewW * WIDTH_FRAC;
  uniforms.uWidthK.value = THREE.MathUtils.clamp(wantWorld / (2 * BUNDLE_R), 0.5, 2.6);
  // Оболочка частиц подстраивается под фактический радиус пучка.
  // Калибровка 0.60 — радиус, под который писались профили систем
  // (halfW 0.41-0.62, uRadius 0.72). Пар и струю лака не трогаем: это фон
  // и сопло, они не привязаны к геометрии пучка.
  const K = uniforms.uWidthK.value / 0.60;
  for (const pts of bundleLayers()) pts.material.uniforms.uBundleK.value = K;
  const px = Math.round(innerWidth * WIDTH_FRAC);
  document.documentElement.style.setProperty('--center', `${px}px`);
}

// Калибровка пузырей: на 1920px самый большой = 75px, самый маленький = 23px
// (+50% к базовым 50/15). Считается РАЗ на resize (не на кадр): деления тут
// можно. В шейдере только умножения (uSize*sz*pxPerUnit). Округление вверх
// до целого пикселя — целочисленным трюком (a+b−1)/b + truncation через |0.
// bubUser сохраняет ?pfp_bubblesize как относительный множитель.
let bubUser = 0;

export function syncResolution(pr) {
  uniforms.uRes.value.set(innerWidth * pr, innerHeight * pr);
  // gl_PointSize считается в CSS-пикселях
  for (const pts of sizedLayers()) pts.material.uniforms.uViewportH.value = innerHeight;
  syncGumSize(innerHeight);
  if (!bubUser) bubUser = bubbles.material.uniforms.uSize.value / 0.40;
  const maxPx = ((75 * innerWidth + 1919) / 1920) | 0;
  const minPx = ((23 * innerWidth + 1919) / 1920) | 0;
  const pxNom = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 11.5);
  const bu = bubbles.material.uniforms;
  bu.uSize.value = (maxPx / pxNom) * bubUser;
  bu.uSizeMin.value = minPx / maxPx;
  syncWidth();
}

export function retargetStrands() {
  strandCap = strandsForWidth(innerWidth);
  if (drawn > strandCap) setStrands(strandCap);
}
