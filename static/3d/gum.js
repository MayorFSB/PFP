// Жвачка из жёстко связанных частиц (этап 1).
//
// Концепция: несколько прядей на 10% высоты склеены жвачкой (склейка —
// в hair.js: стягивание к оси uGumX/uGumZ), а поверх связи лежит
// полупрозрачное розовое пятно. Пятно — THREE.Points (~220 шт).
//
// Жёсткость связи — математическая: якоря взяты из РЕАЛЬНЫХ вершин волос
// (position + aT + aSeed из hair.js), а вершинный шейдер ниже повторяет ТОТ
// ЖЕ displacement, что hair.js. Общие uniform'ы разделяются по ссылке, так
// что пятно трекает пряди точно — и в анимации, и в статике.
//
// ЗЕРКАЛО hair.js — при правке displacement править оба места. Покрывает
// только то, что ненулевое на этапе 1: покой→curl (uWeave), braidK, слабая
// крутка, ветвление (uCurl), fly, idle (uScroll), wild, chaos, склейка.
// wash/cut/wave/iron/salute/drop/finale на этапе 1 равны нулю — их нет.
// shed нет: якоря берутся только с shedH>0.14, такие пряди не отпадают
// (sp ≡ 0 при uShed ≤ 1), что и проверено ниже отбором.
import * as THREE from 'three';
import { scene } from './core.js';
import { geo, uniforms } from './hair.js';
import { TOP, LEN, TL, g } from './config.js';

const COUNT = 220;
const fr = (x) => x - Math.floor(x);

// Отбор якорей: середина массы (t 0.50–0.60), левая сторона (фаза ~0.5),
// неотпадающие пряди (shedH > 0.14).
const posA = geo.getAttribute('position');
const tA = geo.getAttribute('aT');
const sA = geo.getAttribute('aSeed');
const cand = [];
for (let i = 0; i < tA.count; i++) {
  const t = tA.getX(i);
  if (t < 0.50 || t > 0.60) continue;
  const ph = sA.getX(i);
  if (Math.abs(ph - 0.5) > 0.09) continue;
  const jit = sA.getZ(i);
  if (fr(jit * 13.73) <= 0.14) continue;
  cand.push(i);
}

const N = Math.min(COUNT, cand.length);
const gPos = new Float32Array(N * 3);
const gT = new Float32Array(N);
const gSeed = new Float32Array(N * 4);
const gOff = new Float32Array(N * 3);
const gTone = new Float32Array(N);
const gSize = new Float32Array(N);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
for (let k = 0; k < N; k++) {
  const i = cand[Math.floor((k * cand.length) / N)];
  gPos[k * 3] = posA.getX(i);
  gPos[k * 3 + 1] = posA.getY(i);
  gPos[k * 3 + 2] = posA.getZ(i);
  gT[k] = tA.getX(i);
  gSeed[k * 4] = sA.getX(i);
  gSeed[k * 4 + 1] = sA.getY(i);
  gSeed[k * 4 + 2] = sA.getZ(i);
  gSeed[k * 4 + 3] = sA.getW(i);
  // Облако пятна: 8% ширины волос по x (~0.22 полуось), 10% высоты по y
  // (~1.0 full ≈ 0.5 полуось), вперёд к переднему плану (+z bias).
  const ox = gauss();
  const oy = gauss();
  const oz = gauss();
  gOff[k * 3] = ox * 0.22;
  gOff[k * 3 + 1] = oy * 0.50;
  // Вперёд к зрителю: пятно живёт на переднем плане поверх связи.
  gOff[k * 3 + 2] = oz * 0.28 + 0.22;
  // Тон: рваный край — корка, середина — глянец.
  const rim = Math.min(1, (Math.abs(ox) + Math.abs(oy) * 0.7 + Math.abs(oz)) * 0.9
    + Math.random() * 0.25);
  gTone[k] = rim > 0.62 ? 1 : 0;
  gSize[k] = 0.08 + Math.random() * 0.10;
}

const ggeo = new THREE.BufferGeometry();
ggeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
ggeo.setAttribute('aT', new THREE.BufferAttribute(gT, 1));
ggeo.setAttribute('aSeed', new THREE.BufferAttribute(gSeed, 4));
ggeo.setAttribute('aOff', new THREE.BufferAttribute(gOff, 3));
ggeo.setAttribute('aTone', new THREE.BufferAttribute(gTone, 1));
ggeo.setAttribute('aSize', new THREE.BufferAttribute(gSize, 1));

const gumMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime: uniforms.uTime,
    uScroll: uniforms.uScroll,
    uWeave: uniforms.uWeave,
    uCurl: uniforms.uCurl,
    uStraight: uniforms.uStraight,
    uPlyR0: uniforms.uPlyR0,
    uPlyDr: uniforms.uPlyDr,
    uWidthK: uniforms.uWidthK,
    uGum: uniforms.uGum,
    uWild: uniforms.uWild,
    uChaos: uniforms.uChaos,
    uGumX: uniforms.uGumX,
    uGumZ: uniforms.uGumZ,
    uViewportH: { value: 800 },
    uFovHalf: { value: THREE.MathUtils.degToRad(48 * 0.5) },
    uGumA: { value: 0.72 },
  },
  transparent: true,
  depthWrite: false,
  // Передний план: пятно рисуется поверх волос. Пятно сидит спереди массы
  // (+z bias в aOff), позади него ничего нет — артефактов просвечивания нет.
  depthTest: false,
  blending: THREE.NormalBlending,
  vertexShader: `
    attribute float aT;
    attribute vec4 aSeed;
    attribute vec3 aOff;
    attribute float aTone;
    attribute float aSize;
    uniform float uTime, uScroll, uWeave, uCurl, uStraight;
    uniform float uPlyR0, uPlyDr, uWidthK, uGum, uGumX, uGumZ;
    uniform float uWild, uChaos;
    uniform float uViewportH, uFovHalf;
    varying float vTone;
    varying float vSeed;
    const float PI2 = 6.28318530718;
    const float TOP = ${g(TOP)};
    const float LEN = ${g(LEN)};
    void main() {
      float t = aT;
      float phase = aSeed.x;
      float rad = aSeed.y;
      float jit = aSeed.z;
      float splitT = 0.30 + fract(jit * 3.7) * 0.45;
      float fly = step(0.87, fract(jit * 11.3));
      float wf = 0.70 + fract(jit * 2.3) * 0.70;
      float bdir = fract(jit * 7.7) < 0.5 ? -1.0 : 1.0;
      // position-атрибут уже = покой (restPos с волной), recompute не нужен.
      vec3 rest = position;
      float plyN = clamp((rad - uPlyR0) / uPlyDr, 0.0, 1.0);
      float wrad = rad * uWidthK;
      float turns = (0.95 + plyN * 0.55) * (1.0 - uStraight) * (1.0 - 0.65 * uWeave);
      float th = phase * PI2 + t * turns * PI2 + uTime * 0.07;
      float clump = 1.0 + 0.16 * sin(t * 2.7) * (1.0 - uStraight * 0.7);
      float taper = (1.0 - 0.34 * t) * mix(1.0, 0.46, uStraight);
      float R = wrad * taper * clump;
      float wob = 0.10 * (0.3 + plyN);
      vec3 curl = vec3(cos(th) * R, TOP - t * LEN, sin(th) * R * 0.76);
      curl.x += sin(phase * PI2 * 3.0 + t * 4.0) * wob;
      curl.z += cos(phase * PI2 * 2.0 + t * 3.0) * wob * 0.85;
      float braidK = mix(1.0, 0.62, uWeave);
      curl.x *= braidK;
      curl.z *= braidK;
      vec3 p = mix(rest, curl, uWeave);
      float b = max(t - splitT, 0.0);
      p.x += bdir * b * b * 0.90 * uCurl;
      p.z += bdir * b * 1.7 * 0.24 * uCurl;
      vec3 flyOff = vec3(
        sin(uTime * 0.6 + jit * 30.0),
        0.0,
        cos(uTime * 0.5 + jit * 21.0)
      ) * t * 0.55;
      p += fly * flyOff;
      float idle = 1.0 - smoothstep(${g(TL.idle[0])}, ${g(TL.idle[1])}, uScroll);
      float w1 = t * 5.5 * wf - uTime * 1.15 * wf + phase * PI2;
      float w2 = t * 11.0 * wf + uTime * 0.72 + jit * PI2;
      float amp = (0.075 + fly * 0.10) * idle;
      p.x += (sin(w1) * 0.7 + sin(w2) * 0.3) * amp;
      p.z += (cos(w2) * 0.6 + sin(w1 * 0.5) * 0.4) * amp * 0.8;
      float wildPh = t * 3.0 - uTime * 0.9 + plyN * 3.0;
      p.x += sin(wildPh) * bdir * 0.18 * uWild;
      p.z += cos(wildPh * 0.8 + 1.7) * 0.12 * uWild;
      float chH1 = fract(jit * 57.31) - 0.5;
      float chH2 = fract(jit * 91.17) - 0.5;
      float chPh = t * 23.0 + uTime * 2.6 + jit * 6.2831;
      p.x += sin(chPh) * chH1 * 0.28 * uChaos;
      p.z += cos(chPh * 1.3) * chH2 * 0.20 * uChaos;
      p.y += sin(chPh * 0.7 + chH1 * 9.0) * 0.06 * uChaos;
      float gS = 1.0 - smoothstep(0.03, 0.09, abs(phase - 0.5));
      float gT = 1.0 - smoothstep(0.02, 0.035, abs(t - 0.55));
      float gAmt = gS * gT * uGum;
      p.x = mix(p.x, uGumX, gAmt * 0.85);
      p.z = mix(p.z, uGumZ, gAmt * 0.85);
      // Облако — ПОСЛЕ склейки, иначе mix ужмёт смещения на 85%.
      p += aOff;
      vTone = aTone;
      vSeed = jit;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      float pxPerUnit = uViewportH / (2.0 * tan(uFovHalf) * max(-mv.z, 0.1));
      gl_PointSize = max(aSize * pxPerUnit, 1.5);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform float uGum, uGumA;
    varying float vTone;
    varying float vSeed;
    void main() {
      if (uGum < 0.01) discard;
      float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
      float disc = 1.0 - smoothstep(0.55, 1.0, d);
      if (disc < 0.01) discard;
      // Середина — розовый глянец с бликом, край — тёмная корка.
      vec3 gloss = vec3(0.93, 0.42, 0.60) + vec3(0.25) * (1.0 - d) * (1.0 - vTone);
      vec3 crust = vec3(0.42, 0.27, 0.30);
      vec3 col = mix(gloss, crust, vTone * 0.9);
      float a = disc * uGumA * mix(0.55, 0.85, vTone);
      gl_FragColor = vec4(col, a);
    }`,
});

export const gumPts = new THREE.Points(ggeo, gumMat);
gumPts.frustumCulled = false;
gumPts.renderOrder = 6;
gumPts.visible = false;
scene.add(gumPts);

export function syncGumSize(h) {
  gumMat.uniforms.uViewportH.value = h;
}
