// Инструменты: ножницы, утюжок, баллончик лака.
//
// Все три — DOM-оверлеи поверх канваса, а не 3D-меши. Причина: пока камера
// не вращается, SVG дешевле и резче, а позиционирование считается вручную
// через toPxX/toPxY. На этапе D ножницы станут мешем, и тогда здесь появится
// общий ToolBase с материализацией (dissolve-in) и конечным автоматом.
//
// ВАЖНО: инструменты принадлежат стадиям по смыслу, но лежат здесь, а не в
// phases/*, потому что этоpresentation, а не состояние волос. Вызывает их
// соответствующая фаза.
import * as THREE from 'three';
import { toPxX, toPxY } from './core.js';
import { uniforms, cutLine } from './hair.js';
import { cutBits, sprayFast, sprayCloud, steam } from './particles.js';
import { TOP, TL } from './config.js';

// Доля экрана, свободная сверху и снизу — инструменты не должны выступать
export const EDGE_MARGIN = 0.15;

// ---- Ножницы ------------------------------------------------------------
// Геометрия SVG: viewBox 800×600, ось (винт) в (345,275), размер 300×225 px.
const SC_W = 300;
const SC_H = 225;
const SC_SCALE = SC_W / 800;
const SC_OFF_X = 345 * SC_SCALE;
const SC_OFF_Y = 275 * SC_SCALE;

const scissorEl = document.getElementById('scissors');

// Этап стрижки в координатах uScroll — границы в TL.cut, не дублируем числа.
// ВНИМАНИЕ: TL.cut = [0.44, 0.56] НЕ совпадает с PHASE.cut = [0.48, 0.60].
// Ножницы начинают наезжать на 0.44, то есть ещё на стадии services. Это
// осознанное опережение инструмента относительно его секции, зафиксированное
// числом, а не рассинхроном. Правка ритма = правка TL.cut в одном месте.
export function updateScissors(p, time) {
  if (!scissorEl) return;
  // Прогресс ВНУТРИ этапа стрижки
  const cutLocal = Math.min(Math.max((p - TL.cut[0]) / (TL.cut[1] - TL.cut[0]), 0), 1);
  const vis = THREE.MathUtils.smoothstep(cutLocal, 0.08, 0.18)
    * (1 - THREE.MathUtils.smoothstep(cutLocal, 0.86, 0.96));
  if (vis <= 0.002) {
    scissorEl.style.opacity = '0';
    return;
  }
  // Движение только с 15% до 85% этапа
  const t = Math.min(Math.max((cutLocal - 0.15) / 0.70, 0), 1);

  // Ножницы идут ОТ ЛЕВОГО КРАЯ ПУЧКА К ПРАВОМУ, одновременно вниз, и лежат
  // ровно на линии среза — иначе они стригут мимо разреза.
  const sx = -0.78 + t * 1.56;
  const sy = cutLine(sx, t);

  // Ограничение кадра: бокс SVG 300×225, ось (винт) в (345,275)
  const H = innerHeight;
  const topLimit = H * EDGE_MARGIN + SC_OFF_Y;
  const bottomLimit = H * (1 - EDGE_MARGIN) - (SC_H - SC_OFF_Y);
  const py = THREE.MathUtils.clamp(toPxY(sy), topLimit, Math.max(topLimit, bottomLimit));
  const px = THREE.MathUtils.clamp(toPxX(sx), SC_OFF_X, innerWidth - SC_W + SC_OFF_X);

  // Ход: лёгкое открытие → полное закрытие. При смыкании включается
  // дополнительный поток срезанных волос.
  const snipRate = 2.6 + t * 4.2;
  const snip = 0.5 + 0.5 * Math.sin(time * snipRate);
  scissorEl.style.opacity = String(vis);
  scissorEl.style.setProperty('--snip', snip.toFixed(3));
  cutBits.material.uniforms.uSnip.value = snip;
  cutBits.material.uniforms.uScissorX.value = sx;
  cutBits.material.uniforms.uScissorY.value = sy;
  const rot = -10 + t * 16;
  scissorEl.style.transform =
    `translate(${(px - SC_OFF_X).toFixed(1)}px, ${(py - SC_OFF_Y).toFixed(1)}px) rotate(${rot.toFixed(1)}deg)`;
}

// ---- Утюжок: 7 подфаз стадии укладки -----------------------------------
// Границы этапа — TL.style = [0.60, 0.72], они НЕ совпадают с
// PHASE.style = [0.64, 0.76]: утюжок материализуется на 0.60, то есть ещё
// на стадии team. Опережение зафиксировано числом в TL.
//
// Геометрия SVG утюжка: viewBox 800×600, группа сдвинута на (50,40),
// шарнир (380,310) → (430,350) в viewBox. Размер 340×255 px.
// Рабочие концы створок (петли заканчиваются на x≈670) → (720,340) в viewBox.
// Утюжок позиционируется и вращается ЗА КОНЦЫ СТВОРОК, а не за шарнир —
// иначе волосы собираются у основания прибора, а не в рабочей зоне.
const IRON_W = 340;
const IRON_H = 255;
const IRON_SCALE = IRON_W / 800;
const IRON_GRIP_X = 720 * IRON_SCALE;   // 306 — должен совпадать с transform-origin в CSS
const IRON_GRIP_Y = 340 * IRON_SCALE;   // 144.5

const ironEl = document.getElementById('iron');
const ironFieldEl = document.getElementById('iron-field');

/** Мировая позиция точки захвата — концов рабочих створок. */
function ironAnchor(sT) {
  return { x: -0.62, y: 4.2 - sT * 6.6 };   // у левого края пучка, скользит вниз
}

export function updateIron(p) {
  if (!ironEl) return;
  const sT = Math.min(Math.max((p - TL.style[0]) / (TL.style[1] - TL.style[0]), 0), 1);
  // 0.20–0.30 материализация, держится до 0.80 и уходит
  const vis = THREE.MathUtils.smoothstep(sT, 0.20, 0.30)
    * (1 - THREE.MathUtils.smoothstep(sT, 0.80, 0.92));
  if (vis <= 0.002) {
    ironEl.style.opacity = '0';
    uniforms.uWrap.value = 0;
    uniforms.uIronGlow.value = 0;
    uniforms.uCurlDone.value = 0;
    return;
  }
  const a = ironAnchor(sT);

  // Смыкание: 0.40–0.50 закрываются, 0.60–0.72 разжимаются
  const close = THREE.MathUtils.smoothstep(sT, 0.40, 0.50);
  const open = THREE.MathUtils.smoothstep(sT, 0.60, 0.72);
  const jaw = close * (1 - open);

  ironEl.style.opacity = String(vis);
  ironEl.style.setProperty('--jaw', jaw.toFixed(3));
  if (ironFieldEl) ironFieldEl.setAttribute('opacity', (jaw * vis * 0.8).toFixed(3));

  // Ограничение кадра: 15% сверху и снизу
  const H = innerHeight;
  const topLimit = H * EDGE_MARGIN + IRON_GRIP_Y;
  const bottomLimit = H * (1 - EDGE_MARGIN) - (IRON_H - IRON_GRIP_Y);
  const py = THREE.MathUtils.clamp(toPxY(a.y), topLimit, Math.max(topLimit, bottomLimit));
  const px = THREE.MathUtils.clamp(toPxX(a.x), IRON_GRIP_X, innerWidth - IRON_W + IRON_GRIP_X);

  // Наклон вокруг точки захвата: transform-origin в CSS = IRON_GRIP, поэтому
  // концы створок остаются на месте, а корпус поворачивается
  const rot = -8 + sT * 12;
  ironEl.style.transform =
    `translate(${(px - IRON_GRIP_X).toFixed(1)}px, ${(py - IRON_GRIP_Y).toFixed(1)}px) rotate(${rot.toFixed(1)}deg)`;

  // Шаг 2 (0.30–0.42): прядь обвивается вокруг рабочей области. Держится,
  // пока створки сомкнуты, и спадает при отпускании (0.68–0.82).
  uniforms.uWrap.value = THREE.MathUtils.smoothstep(sT, 0.30, 0.42)
    * (1 - THREE.MathUtils.smoothstep(sT, 0.68, 0.82));
  // Шаг 6 (0.66–0.84): после отпускания прядь остаётся завитой. Растёт
  // монотонно — в отличие от uWrap, который спадает.
  uniforms.uCurlDone.value = THREE.MathUtils.smoothstep(sT, 0.66, 0.84);
  // Пар/дымок в точке контакта концов створок с волосами (шаг 4, 0.50–0.60)
  uniforms.uIronGlow.value = jaw * vis;
  uniforms.uIronPos.value.set(a.x, a.y, 0);
  // Пар собирается у створок только пока идёт завивка
  steam.material.uniforms.uIronFocus.value = THREE.MathUtils.smoothstep(sT, 0.44, 0.54)
    * (1 - THREE.MathUtils.smoothstep(sT, 0.66, 0.78));
}

// ---- Баллончик лака: 5 подфаз ------------------------------------------
// Этап fix = TL.fix [0.76, 0.88] (PHASE.fix то же), прогресс sT:
//   0.00–0.20 исходное состояние (баллончика нет)
//   0.20–0.30 материализация баллончика, сопло наводится
//   0.30–0.55 спрей 1: направленный быстрый поток, кнопка нажимается
//   0.55–0.80 спрей 2: широкое медленное облако, первый поток затухает
//   0.40–1.00 блеск растёт, пряди склеиваются (перекрывает 3–4, как в ТЗ)
const FIX_FROM = TL.fix[0];
const FIX_TO = TL.fix[1];

// Баллончик: viewBox 160×460. Наклон задаёт и наведение сопла:
// ось баллончика (0,−1) после поворота θ становится (sin θ, −cos θ) в
// экранных координатах, т.е. в мире (sin θ, −cos θ) с +y вверх.
const SPRAY_W = 150;
const SPRAY_H = 431;
// Поворот CSS считается по часовой стрелке (в экранных координатах +y вниз),
// отражение по вертикали — scaleY(-1). Знак угла подобран так, чтобы
// баллончик стоял почти вертикально (≈70° к OX), а сопло — внизу, у пряди.
const SPRAY_ROT = -60;
const SPRAY_FLIP_Y = -1;
// Якорь = кончик сопла в координатах viewBox (70, 51), пересчитанный в
// масштаб элемента. Если якорь не совпадает с соплом, струя частиц визуально
// расходится с баллончиком (так и было: стоял (84, 396)).
const SPRAY_NOZZLE_VB = { x: 70, y: 51 };
const SPRAY_ANCHOR_X = SPRAY_NOZZLE_VB.x * (SPRAY_W / 160);
const SPRAY_ANCHOR_Y = SPRAY_NOZZLE_VB.y * (SPRAY_H / 460);
// Баллончик слева от пучка, сопло смотрит вправо-вниз на волосы
const SPRAY_AIM_X = -1.45;

/**
 * Ось сопла в мировых координатах, выведенная из самого CSS-трансформа.
 *
 * Локальная ось сопла в SVG — (0,−1) (вверх в viewBox). Трансформа элемента
 * `rotate(θ) scaleY(f)`, поэтому ось в экранных координатах:
 *   S(f)·(0,−1) = (0, −f)
 *   R(θ)·(0,−f) = (f·sinθ, −f·cosθ)
 * Мир отличается только знаком y (+y вверх), значит:
 *   dir = (f·sinθ, f·cosθ)
 *
 * Формула выводится из трансформа, а не пишется руками: при любом угле и
 * любом отражении струя остаётся в сопле.
 */
function sprayAxis() {
  const th = (SPRAY_ROT * Math.PI) / 180;
  return new THREE.Vector3(
    SPRAY_FLIP_Y * Math.sin(th),
    SPRAY_FLIP_Y * Math.cos(th),
    0,
  ).normalize();
}

const sprayEl = document.getElementById('spray');
// Поворот вокруг кончика сопла — иначе translate и rotate считаются от угла
// элемента и баллончик уезжает из-под струи.
if (sprayEl) {
  sprayEl.style.transformOrigin =
    `${SPRAY_ANCHOR_X.toFixed(2)}px ${SPRAY_ANCHOR_Y.toFixed(2)}px`;
}

export function updateFix(p) {
  if (!sprayEl) return;
  const sT = Math.min(Math.max((p - FIX_FROM) / (FIX_TO - FIX_FROM), 0), 1);
  const S = THREE.MathUtils;

  // Этап 2 (0.20–0.30): баллончик появляется слева и наводится
  const vis = S.smoothstep(sT, 0.20, 0.30)
    * (1 - S.smoothstep(sT, 0.82, 0.94));
  if (vis <= 0.002) {
    sprayEl.style.opacity = '0';
    for (const pts of [sprayFast, sprayCloud]) pts.visible = false;
    return;
  }

  // Позиция: сопло точно в цели, тело баллончика уходит от волос
  const aimY = 3.4 - sT * 5.2;
  const ax = SPRAY_ANCHOR_X;
  const ay = SPRAY_ANCHOR_Y;
  const H = innerHeight;
  const px = THREE.MathUtils.clamp(
    toPxX(SPRAY_AIM_X), ax + 6, innerWidth - SPRAY_W * 1.4,
  );
  const py = THREE.MathUtils.clamp(toPxY(aimY), ay + H * EDGE_MARGIN, H * (1 - EDGE_MARGIN));

  sprayEl.style.opacity = String(vis);
  sprayEl.style.transform = `translate(${(px - ax).toFixed(1)}px, ${(py - ay).toFixed(1)}px) `
    + `rotate(${SPRAY_ROT}deg) scaleY(${SPRAY_FLIP_Y})`;

  // Направление струи берём из того же трансформа, что и у баллончика
  const nozzle = new THREE.Vector3(SPRAY_AIM_X, aimY, 0.95);
  const dir = sprayAxis();

  // Этап 3 (0.30–0.55): кнопка нажимается, идёт струя
  const press = S.smoothstep(sT, 0.30, 0.34)
    * (1 - S.smoothstep(sT, 0.54, 0.58));
  sprayEl.style.setProperty('--press', press.toFixed(3));

  const fastOn = S.smoothstep(sT, 0.30, 0.36)
    * (1 - S.smoothstep(sT, 0.55, 0.66));
  const cloudOn = S.smoothstep(sT, 0.53, 0.62)
    * (1 - S.smoothstep(sT, 0.78, 0.86));

  for (const [pts, amt] of [[sprayFast, fastOn], [sprayCloud, cloudOn]]) {
    const u = pts.material.uniforms;
    u.uNozzle.value.copy(nozzle);
    u.uDir.value.copy(dir);
    u.uLacquer.value = amt;
    pts.visible = amt > 0.01;
  }
}
