// Трёх-синглтоны сцены: renderer, scene, camera. Плюс проекция world→CSS-пиксели
// и мышь.
//
// Сюда НЕЛЬЗЯ тащить состояние волос и частиц: этот модуль должен оставаться
// перечитываемым за один экран. Всё, что меняется от стадии к стадии, живёт
// в hair (uniforms) и phases/*.
import * as THREE from 'three';
import { isMobile } from './config.js';

const mount = document.getElementById('hero3d');
if (!mount) throw new Error('No #hero3d');

export const renderer = new THREE.WebGLRenderer({
  antialias: true, alpha: true, powerPreference: 'high-performance',
});
// node --check не видит GLSL (он лежит в строке), а лишняя скобка валит
// шейдер целиком. Поэтому включаем явную диагностику Three.js.
renderer.debug.checkShaderErrors = true;
renderer.debug.onShaderError = (gl, program, vs, fs) => {
  console.error('[lock] ШЕЙДЕР НЕ СОБРАЛСЯ\nVERT:',
    (gl.getShaderInfoLog(vs) || '').trim(),
    '\nFRAG:', (gl.getShaderInfoLog(fs) || '').trim());
};

/**
 * Проверка баланса скобок в GLSL — самая частая ошибка при правке строк.
 * Ловит опечатку до похода в GPU, но не ловит необъявленный uniform —
 * для этого есть onShaderError выше.
 */
export function checkGlsl(label, src) {
  const o = (src.match(/\{/g) || []).length;
  const c = (src.match(/\}/g) || []).length;
  if (o !== c) console.error(`[lock] ${label}: скобки не сбалансированы { =${o}, } =${c}`);
  return o === c;
}

// Адаптивный DPR: лесенка резкости для governor (main.js).
// Старт — как раньше (до 1.5 десктоп / 1.25 мобайл), потолок — 2.0.
// На dpr=1 экранах лесенка из одного значения — governor работает как раньше,
// только нитями. Шаги дискретные: backing store пересоздаётся на каждый шаг,
// поэтому только по cooldown, а не каждый кадр.
const PR_MIN = 1.0;
const PR_MAX = Math.min(devicePixelRatio || 1, 2.0);
const PR_STEPS = [1.0, 1.25, 1.5, 2.0].filter((v) => v >= PR_MIN && v <= PR_MAX);
let prIdx = 0;
{
  const initPR = Math.min(devicePixelRatio || 1, isMobile ? 1.25 : 1.5);
  for (let i = 0; i < PR_STEPS.length; i++) if (PR_STEPS[i] <= initPR) prIdx = i;
}
export const getPR = () => PR_STEPS[prIdx];
export const PR_CAP = PR_STEPS[PR_STEPS.length - 1];
/** Шаг резкости: dir −1/+1. Возвращает true, если ступень сменилась. */
export function stepPR(dir) {
  const n = Math.min(Math.max(prIdx + dir, 0), PR_STEPS.length - 1);
  if (n === prIdx) return false;
  prIdx = n;
  renderer.setPixelRatio(PR_STEPS[prIdx]);
  return true;
}

renderer.setPixelRatio(PR_STEPS[prIdx]);
renderer.setSize(innerWidth, innerHeight);
mount.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 60);
camera.position.set(0, 0, 11.5);

// База и точка взгляда камеры. Облёт финального этапа считается как смещение
// от CAM_BASE. z не трогаем: halfViewH/toPxX/toPxY опираются на
// camera.position.z (камера не вращается), и его изменение рассинхронизировало
// бы DOM-оверлеи инструментов.
export const CAM_BASE = new THREE.Vector3(0, 0, 11.5);
export const CAM_TARGET = new THREE.Vector3(0, 0, 0);

// Видимая половина кадра в world-координатах. Пересчитывается на resize,
// поэтому let + live binding: импортеры видят новое значение без событий.
export const halfViewH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * camera.position.z;
export let halfViewW = halfViewH * camera.aspect;

export function syncCameraAspect() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  halfViewW = halfViewH * camera.aspect;
}

/**
 * World → CSS-пиксели. Вручную, а не через проекцию: камера не вращается,
 * поэтому NDC = offset / half. Как только камера начнёт вращаться (этап D,
 * ножницы станут мешем) эти функции придётся заменить на Vector3.project().
 */
export const toPxX = (x) => ((x / halfViewW) * 0.5 + 0.5) * innerWidth;
export const toPxY = (y) => (1 - ((y / halfViewH) * 0.5 + 0.5)) * innerHeight;

// Мышь в мировых координатах. 9999 — «вне окна», чтобы гало гасло без
// отдельного флага (pointerleave сбрасывает в то же значение).
export const mouse = { x: 9999, y: 9999 };
export const mTarget = { x: 9999, y: 9999 };
addEventListener('pointermove', (e) => {
  mTarget.x = (e.clientX / innerWidth - 0.5) * 2 * halfViewW;
  mTarget.y = -(e.clientY / innerHeight - 0.5) * 2 * halfViewH;
}, { passive: true });
addEventListener('pointerleave', () => { mTarget.x = 9999; mTarget.y = 9999; });

/** Строка статуса под канвасом (кнопка «Анимация»). */
export function setStatus(t) {
  const el = document.getElementById('particles-toggle');
  if (el) el.textContent = t;
}
