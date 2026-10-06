// Системы частиц. Одна фабрика makePoints() на всё: пул, общая геометрия
// атрибутов и общий шаблон шейдера, в который система подставляет своё
// позиционирование (cfg.vert) и свою отрисовку (fragBody).
//
// Все формы процедурные: читаются из gl_PointCoord, внешних текстур нет.
// Причина — правило репозитория: бинарные ассеты в git не кладутся.
//
// Гейт в общем fragment-шейдере отбрасывает систему, когда ни один из
// управляющих uniform'ов не активен. Поэтому у каждой системы свой набор
// «пусков»: uWash (мытьё), uSteam (пар), uCut (срез), uLacquer (лак),
// uGlitter (блестки).
import * as THREE from 'three';
import { camera, scene } from './core.js';
import { uniforms } from './hair.js';
import { TOP, LEN, qn } from './config.js';

/**
 * cfg.sizePow — распределение размеров через pow(): большой показатель даёт
 *   много мелких и редкие крупные.
 * cfg.run     — доля «бегущих» частиц: они быстро едут вниз, угол квантуется,
 *               поэтому они выстраиваются в струю, а не разлетаются.
 * cfg.vert    — свой код позиционирования (для струй и всплесков).
 */
export function makePoints(count, fragBody, cfg) {
  const g = new THREE.BufferGeometry();
  const seed = new Float32Array(count * 4);
  const extra = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seed[i * 4] = Math.random();      // фаза появления/скольжения
    seed[i * 4 + 1] = Math.random();  // старт вдоль нити
    seed[i * 4 + 2] = Math.random();  // угол вокруг bundle
    seed[i * 4 + 3] = Math.random();  // размер
    extra[i * 4] = Math.random();
    extra[i * 4 + 1] = Math.random();
    extra[i * 4 + 2] = Math.random();
    extra[i * 4 + 3] = Math.random();
  }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('aDrop', new THREE.BufferAttribute(seed, 4));
  g.setAttribute('aExtra', new THREE.BufferAttribute(extra, 4));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 30);
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uTime: uniforms.uTime,
      uWash: { value: 0 },
      uSteam: { value: 0 },
      uCut: { value: 0 },
      uSnip: { value: 0 },
      uScissorX: { value: 0 },
      uScissorY: { value: 0 },
      uIronPos: uniforms.uIronPos,
      uIronFocus: { value: 0 },
      uSize: { value: cfg.size },
      uSizePow: { value: cfg.sizePow },
      uSizeMin: { value: cfg.sizeMin },
      uRun: { value: cfg.run ?? 0 },
      uRunSpeed: { value: cfg.runSpeed ?? 0.3 },
      uSpeedA: { value: cfg.speedA ?? 0.035 },
      uSpeedB: { value: cfg.speedB ?? 0.075 },
      uSpin: { value: cfg.spin ?? 0.25 },
      uCling: { value: cfg.cling ? 1 : 0 },
      uTop: { value: TOP },
      // span обязан перекрывать весь кадр: видимая высота ≈ 2*tan(fov/2)*z ≈ 10.2,
      // при TOP=7.6 низ кадра на y≈-5.1. Короткий span давал пену только
      // в верхней трети экрана.
      uSpan: { value: cfg.span },
      uRadius: { value: 0.72 },
      uViewportH: { value: 800 },
      uFovHalf: { value: THREE.MathUtils.degToRad(camera.fov * 0.5) },
      // Параметры струи. Объявлены здесь, а не только через Object.assign ниже:
      // иначе uniform, добавленный после конструктора, оказывается undefined
      // при первом обращении из update-функции.
      uNozzle: { value: new THREE.Vector3(0, 0, 0) },
      uDir: { value: new THREE.Vector3(-1, 0, 0) },
      uJetLen: { value: 1.5 },
      uSpread: { value: 0.10 },
      uRise: { value: 0.02 },
      uBrake: { value: 0.10 },
      uFadeEnd: { value: 0.72 },
      uLacquer: { value: 0 },
      // Масштаб поперечного радиуса под ширину пучка. Профили частиц
      // (halfW 0.41-0.62, uRadius 0.72) писались под пучок радиусом ~0.6;
      // без этого множителя на широком экране пузыри и блёстки вжимаются
      // внутрь пучка вместо «по бокам» и «по объёму».
      uBundleK: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: cfg.depthTest !== false,
    blending: THREE.NormalBlending,
    vertexShader: `
      attribute vec4 aDrop;
      attribute vec4 aExtra;
      uniform float uTime, uSize, uSizePow, uSizeMin, uRun, uRunSpeed;
      uniform float uSpeedA, uSpeedB, uSpin, uCling;
      uniform float uTop, uSpan, uRadius, uViewportH, uFovHalf;
      uniform float uBundleK;
      uniform float uSnip, uScissorX, uScissorY, uIronFocus;
      uniform vec3 uIronPos, uNozzle, uDir;
      uniform float uJetLen, uSpread, uRise, uBrake, uFadeEnd, uLacquer;
      varying float vLife;
      varying float vSeed;
      void main() {
        float sz = mix(uSizeMin, 1.0, pow(aDrop.w, uSizePow));
        vSeed = aDrop.x;
        vLife = 0.5;
        vec3 p = vec3(0.0);
        ${cfg.vert}
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        // Мировой размер → пиксели через перспективное деление
        float pxPerUnit = uViewportH / (2.0 * tan(uFovHalf) * max(-mv.z, 0.1));
        gl_PointSize = max(uSize * sz * pxPerUnit, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uWash;
      uniform float uSteam;
      uniform float uCut;
      uniform float uLacquer;
      uniform float uGlitter;
      uniform float uTime;
      varying float vLife;
      varying float vSeed;
      void main() {
        // uGlitter обязателен в гейте: glitter делит с остальными системами
        // только uGlitter, а его uWash/uSteam/uCut/uLacquer — локальные нули,
        // которые никто не обновляет. Без uGlitter в условии все четыре были
        // нулями → discard на каждом фрагменте → блестки финала не рисовались
        // вообще. У систем без uGlitter Three.js не ставит uniform → GLSL
        // даёт дефолт 0 → их поведение не меняется.
        if (uWash < 0.01 && uSteam < 0.01 && uCut < 0.01 && uLacquer < 0.01
            && uGlitter < 0.01) discard;
        ${fragBody}
      }`,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = cfg.renderOrder ?? 2;
  pts.visible = false;
  scene.add(pts);
  return pts;
}

// ---- Этап 6: блестки в объёме пучка --------------------------------------
// ТЗ просит спавнить частицы в вершинах hair_mesh. Точная привязка потребовала
// бы прокидывать геометрию нитей в vertex shader этого материала (другая
// программа, другая сетка атрибутов). Поэтому берём тот же объём пучка —
// эллипсоид по радиусу uRadius и высоте TOP — и колеблем частицы по X/Z.
const glitterFrag = `
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;
  // Мерцание: своя фаза на частицу + экспоненциальное затухание к краю,
  // иначе пыль читается как ровная сетка точек.
  float tw = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * 2.1 + vSeed * 61.0), 2.0);
  float core = exp(-r * r * 7.0);
  float halo = exp(-r * r * 2.2) * 0.35;
  float a = (core + halo) * tw * uGlitter;
  gl_FragColor = vec4(mix(vec3(1.0, 0.95, 0.84), vec3(1.0), core), a);
`;

const GLITTER_VERT = `
  // Радиус сжат к центру пучка: у самого края блестки не нужны.
  float rr = uRadius * (0.25 + 0.75 * aDrop.w) * sqrt(aDrop.z) * uBundleK;
  float ang = aDrop.x * 6.28318530718;
  // Высота по всей длине локона, TOP — общий верхний край.
  float yy = uTop - aDrop.y * uTop * 1.32;
  p = vec3(cos(ang) * rr, yy, sin(ang) * rr * 0.85);
  // Покачивание в воздухе: только X/Z, без направленной скорости (ТЗ).
  float ph = aExtra.x * 6.28318530718;
  p.x += sin(uTime * 0.55 + ph) * 0.075;
  p.z += cos(uTime * 0.41 + ph * 1.7) * 0.075;
  vSeed = aDrop.x;
  vLife = 1.0;
`;

export const glitter = makePoints(qn('pfp_glitter', 900, 0, 4000), glitterFrag, {
  size: 0.055, sizePow: 2.4, sizeMin: 0.30,
  // depthTest выключен намеренно: нити рисуются с depthWrite, поэтому блестки
  // внутри объёма пучка перекрывались бы передними нитями и не были видны.
  span: 1, depthTest: false, renderOrder: 7,
  vert: GLITTER_VERT,
});
glitter.material.uniforms.uGlitter = uniforms.uGlitter;

// ---- Этап 2, система 1: пузыри СЛЕВА и СПРАВА ---------------------------
// Мыльный пузырь по референсу: радужный ободок (тонкая плёнка), яркая
// каустика снизу-слева, тёмное полупрозрачное тело, два блика.
const bubbleFrag = `
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  // Контур: сумма трёх несоизмеримых гармоник со случайными фазами.
  // Чистая sin(a*N) даёт N-симметрию — это читалось как звезда, поэтому
  // берём несоизмеримые частоты.
  float ang = atan(uv.y, uv.x);
  float wob = 0.945 + 0.030 * (
      sin(ang * 3.0 + vSeed * 37.0) * 0.45
    + sin(ang * 5.0 - vSeed * 19.0) * 0.32
    + sin(ang * 8.0 + vSeed * 71.0) * 0.23);
  float rr = r / wob;
  if (rr > 1.0) discard;

  float rim = smoothstep(0.70, 0.99, rr);
  // Каустика — яркая дуга по нижне-левой кромке
  float arc = smoothstep(0.78, 0.99, rr) * smoothstep(0.60, -0.30, uv.y + uv.x * 0.6);
  // Тонкая плёнка: cosine palette даёт радужный ободок
  vec3 irid = 0.5 + 0.5 * cos(6.28318530718 * (rr * 2.1 + vSeed + vec3(0.0, 0.33, 0.67)));
  vec3 col = mix(vec3(0.09, 0.11, 0.15), irid * 0.9, rim);
  col += vec3(1.0) * arc * 0.95;
  col += vec3(1.0) * smoothstep(0.17, 0.0, length(uv - vec2(-0.33, 0.36))) * 0.95;
  col += vec3(0.92) * smoothstep(0.11, 0.0, length(uv - vec2(0.30, 0.45))) * 0.60;

  float body = 1.0 - smoothstep(0.0, 0.97, rr);
  gl_FragColor = vec4(col, (rim * 0.80 + arc * 0.45 + body * 0.10) * uWash);
`;

export const bubbles = makePoints(qn('pfp_bubbles', 90, 0, 4000), bubbleFrag, {
  // На 82px низкочастотная гармоника контура читалась как многоугольник —
  // поэтому амплитуда ниже и 3-я гармоника взвешена.
  size: qn('pfp_bubblesize', 0.40, 0.05, 6), sizePow: 3.0, sizeMin: 0.24,
  span: LEN * 0.92, renderOrder: 2,
  vert: `
  // Две лопасти: sign выбирает сторону. |x| заведомо больше радиуса bundle
  // на этой высоте, поэтому пузырь никогда не пересекает волосы.
  float side = aDrop.x < 0.5 ? -1.0 : 1.0;
  float t = uTime;
  // Живое движение: дрейф по высоте + покачивание + орбита вокруг локона
  float drift = sin(t * 0.22 + aDrop.z * 12.0) * 0.13;
  float u = clamp(aDrop.y + drift, 0.0, 1.0);
  float y = uTop - u * uSpan + sin(t * 0.75 + aDrop.x * 25.0) * 0.10;
  float halfW = mix(0.41, 0.62, 1.0 - u);
  // Масштабируем итоговый радиус ОДИН раз. Если умножить halfW отдельно, а
  // потом ещё и r целиком, компонент от halfW получит uBundleK дважды.
  float r = (halfW + 0.30 + aDrop.w * 0.95 + sin(t * 0.55 + aDrop.w * 18.0) * 0.13) * uBundleK;
  float ang = (aDrop.z - 0.5) * 0.85;
  p = vec3(side * r * cos(ang), y, sin(ang) * r * 0.9);
  // Пульсация размера — пузырь «дышит»
  sz *= 0.82 + 0.18 * sin(t * 1.25 + aDrop.x * 40.0);
`,
});

// ---- Этап 2, система 2: вода в волосах ----------------------------------
const waterFrag = `
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;
  float rim = smoothstep(0.55, 0.98, r);
  float hi = smoothstep(0.34, 0.0, length(uv - vec2(-0.32, 0.34)));
  float body = 1.0 - smoothstep(0.0, 0.9, r);
  // Капля смотрит в тень снизу — преломление
  float shade = 0.55 + 0.45 * (uv.y * 0.5 + 0.5);
  vec3 col = mix(vec3(0.34, 0.38, 0.46) * shade, vec3(1.0), rim * 0.85) + hi * 0.95;
  gl_FragColor = vec4(col, (body * 0.55 + rim * 0.40 + hi * 0.5) * uWash);
`;
export const water = makePoints(qn('pfp_water', 480, 0, 4000), waterFrag, {
  size: qn('pfp_watersize', 0.0935, 0.01, 1), sizePow: 1.8, sizeMin: 0.32,
  span: LEN * 0.92, depthTest: false, renderOrder: 3,
  vert: `
  // Сверху много, снизу меньше: pow(>1) сдвигает распределение к верху.
  float u = pow(aDrop.y, 2.4);
  // ~28% — стекающие капли: вода бежит по волосам, а не висит бусинами.
  float isDrip = step(0.72, aDrop.x);
  u = mix(u, fract(aDrop.y + uTime * (0.05 + aDrop.w * 0.07)), isDrip);
  vLife = isDrip;

  float halfW = mix(0.41, 0.62, 1.0 - clamp(u, 0.0, 1.0)) * uBundleK;
  // Только ПЕРЕДНЯЯ полусфера. depthTest выключен (bundle непрозрачный и
  // забивает depth), поэтому частицы с задней стороны просвечивали бы
  // сквозь волосы. Здесь cos(ang) > 0 — z всегда впереди.
  float ang = (aDrop.z - 0.5) * 1.6;
  float r = halfW * (0.92 + aDrop.w * 0.16);
  p = vec3(sin(ang) * r, uTop - u * uSpan, cos(ang) * r * 0.8);
  p.x += sin(uTime * 0.8 + aDrop.x * 20.0) * 0.022;
  // Стекающие чуть крупнее — читаются как ручейки
  sz *= 1.0 + isDrip * 0.45;
`,
});

// ---- Этап 2, система 3: белая густая пена ОБЛАКАМИ ----------------------
// aDrop.xyz — смещение частицы внутри облака, aDrop.w — разброс размера.
// aExtra: x = фаза облака, y = слот, z = скорость, w = размер облака
// Пена шампуня: плотное белое ядро + видимые мелкие пузырьки внутри комка.
// Без колец внутри частицы пена читалась как туман, а не как мыло.
const foamFrag = `
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;

  float core = 1.0 - smoothstep(0.45, 1.0, r);
  float edge = smoothstep(1.0, 0.78, r);

  // 5 вложенных пузырьков внутри комка
  float rings = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float h1 = fract(sin(vSeed * 91.7 + fi * 13.1) * 43758.5453);
    float h2 = fract(sin(vSeed * 57.3 + fi * 29.7) * 43758.5453);
    float h3 = fract(sin(vSeed * 33.1 + fi * 47.3) * 43758.5453);
    vec2 c = (vec2(h1, h2) - 0.5) * 1.0;
    float rad = 0.13 + h3 * 0.27;
    float d = length(uv - c) / max(rad, 1e-3);
    rings = max(rings, smoothstep(1.04, 0.82, d) * smoothstep(0.40, 0.90, d));
  }

  vec3 col = vec3(0.88, 0.92, 0.96) + rings * 0.50;
  gl_FragColor = vec4(col, clamp((core * 0.50 + rings * 0.42) * edge * vLife * uWash, 0.0, 1.0));
`;
const FOAM_CLOUDS = qn('pfp_foamclouds', 17, 1, 200);
const FOAM_PER = qn('pfp_foampp', 18, 5, 40);
export const foamRivulet = makePoints(FOAM_CLOUDS * FOAM_PER, foamFrag, {
  size: 0.16, sizePow: 1.1, sizeMin: 0.70,
  span: LEN * 0.92, depthTest: false, renderOrder: 4,
  vert: `
  // Облако едет как целое: все его частицы делят одну базу (aExtra), поэтому
  // держатся кучей. Раньше частицы вытягивались в цепочку по y — это и
  // читалось как перхоть.
  float t = uTime;
  float b = 0.10 + fract(t * (0.024 + aExtra.z * 0.030) + aExtra.x) * 0.50;
  vLife = smoothstep(0.0, 0.05, b) * (1.0 - smoothstep(0.58, 0.92, b));

  float halfW = mix(0.41, 0.62, 1.0 - clamp(b, 0.0, 1.0));
  // Азимут по фронту bundle: облака липнут к разным прядям, а не висят
  // все в одной плоскости. Плюс покачивание.
  float az = (aExtra.z - 0.5) * 1.5;
  // Только поперечный компонент от halfW масштабируется вместе с шириной
  // пучка; покачивание (0.07) — это собственное движение облака, его
  // растягивать нельзя, иначе облако «разъезжается» по вертикали.
  float cx = sin(az) * halfW * 0.95 * uBundleK + sin(t * 0.45 + aExtra.x * 20.0) * 0.07;
  float cz = cos(az) * halfW * 0.80 * uBundleK;

  // Компактное облако: смещение частицы внутри шара
  float spread = 0.15 + aExtra.w * 0.06;
  p = vec3(
    cx + aDrop.x * spread,
    uTop - b * uSpan + aDrop.y * spread * 1.5,
    cz + aDrop.z * spread * 0.55
  );
  sz *= 0.78 + aExtra.w * 0.45;
`,
});
// Упаковываем частицы в облака. Фазы берём из ХЕША, а не из золотой
// последовательности: низкий дискриминант давал равномерное появление,
// а нужно хаотичное.
{
  const a = foamRivulet.geometry.attributes.aExtra.array;
  const d = foamRivulet.geometry.attributes.aDrop.array;
  const total = foamRivulet.geometry.attributes.aDrop.count;
  const hash = (n) => {
    const x = Math.sin(n * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  for (let i = 0; i < total; i++) {
    const cloud = Math.floor(i / FOAM_PER);
    // Смещение внутри облака — точка в шаре (кубическое отклонение даёт
    // равномерное заполнение, в отличие от суммы трёх uniform)
    let x = 0, y = 0, z = 0, s2 = 0;
    do {
      x = Math.random() * 2 - 1;
      y = Math.random() * 2 - 1;
      z = Math.random() * 2 - 1;
      s2 = x * x + y * y + z * z;
    } while (s2 > 1 || s2 < 1e-6);
    d[i * 4] = x;
    d[i * 4 + 1] = y;
    d[i * 4 + 2] = z;
    d[i * 4 + 3] = Math.random();

    a[i * 4] = hash(cloud + 1);                    // случайная фаза
    a[i * 4 + 1] = (i % FOAM_PER) / (FOAM_PER - 1); // слот
    a[i * 4 + 2] = hash(cloud + 91);               // скорость + азимут
    a[i * 4 + 3] = hash(cloud + 211);              // размер облака
  }
  foamRivulet.geometry.attributes.aExtra.needsUpdate = true;
  foamRivulet.geometry.attributes.aDrop.needsUpdate = true;
}

// ---- Пар: задний фон на мытье и сильно на укладке (этапы 2 и 4) ---------
const steamFrag = `
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;
  float a2 = atan(uv.y, uv.x);
  float n = sin(a2 * 3.0 + vSeed * 20.0) * 0.5 + sin(a2 * 5.0 - vSeed * 11.0) * 0.3;
  float wob = 0.78 + 0.16 * n;
  float body = 1.0 - smoothstep(0.0, wob, r / wob);
  vec3 col = vec3(0.76, 0.81, 0.87);
  gl_FragColor = vec4(col, pow(body, 1.7) * vLife * 0.085 * uSteam);
`;
export const steam = makePoints(qn('pfp_steam', 117, 0, 4000), steamFrag, {
  size: 1.5, sizePow: 1.6, sizeMin: 0.35,
  span: LEN * 1.5, renderOrder: 1,
  vert: `
  // Подъём снизу вверх с циклом + боковой снос
  float u = fract(aDrop.y + uTime * (0.012 + aDrop.w * 0.016));
  float y = mix(-8.5, 9.5, u);
  float ang = aDrop.z * 6.28318530718 + uTime * 0.05;
  float rad = 1.3 + aDrop.w * 2.6 + sin(uTime * 0.2 + aDrop.x * 9.0) * 0.4;
  vLife = smoothstep(0.0, 0.12, u) * (1.0 - smoothstep(0.62, 1.0, u));
  // p уже объявлен в общем шаблоне — присваиваем, а не объявляем заново
  p = vec3(cos(ang) * rad + sin(uTime * 0.15 + aDrop.x * 20.0) * 0.6,
           y,
           sin(ang) * rad * 0.5 - 1.2);
  // На завивке пар собирается в месте смыкания створок утюжка
  vec3 atIron = uIronPos + vec3(aDrop.x - 0.5, aDrop.y - 0.5, aDrop.z - 0.5) * 0.85;
  p = mix(p, atIron, uIronFocus);
  sz *= 0.7 + aDrop.w * 0.6;
`,
});

// ---- Этап 3: срезанные волоски ------------------------------------------
// Два слоя в одной системе: базовый (aExtra.x=0) и «burst» (aExtra.x=1),
// который оживает только при ПОЛНОМ закрытии ножниц (uSnip → 1) и вылетает
// из-под ножниц.
const cutBitFrag = `
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  // Волосок слегка извитый по длине
  float w = 0.16 + 0.09 * sin(uv.y * 5.0 + vSeed * 20.0);
  float body = (1.0 - smoothstep(0.0, w, abs(uv.x)))
             * (1.0 - smoothstep(0.45, 1.0, abs(uv.y)));
  vec3 col = mix(vec3(0.26, 0.17, 0.07), vec3(0.88, 0.71, 0.40),
                 0.5 + 0.5 * sin(vSeed * 30.0));
  gl_FragColor = vec4(col, body * vLife * 0.95 * uCut);
`;
export const CUT_BITS = qn('pfp_cutbits', 1040, 0, 6000);
export const cutBits = makePoints(CUT_BITS, cutBitFrag, {
  size: 0.075, sizePow: 1.5, sizeMin: 0.45,
  span: LEN, depthTest: false, renderOrder: 3,
  vert: `
  float layer = aExtra.x;                 // 0 — базовый, 1 — burst при смыкании
  float rate = mix(0.16 + aDrop.w * 0.20, 0.55 + aDrop.w * 0.45, layer);
  // Burst-слой включается только когда лезвия сомкнулись
  float gate = mix(1.0, smoothstep(0.80, 0.99, uSnip), layer);

  float life = fract(aDrop.y + uTime * rate);
  // Рождаются под лезвиями и падают за нижний край кадра. Раньше старт был
  // фиксированным (y=2.0) — частицы появлялись из пустоты посреди пучка.
  float y = mix(uScissorY - 0.3, -11.0, life * life);
  float x = (aDrop.z - 0.5) * 1.6
          + sin(uTime * 2.2 + aDrop.x * 20.0) * 0.20 * life;
  // Burst вылетает из-под ножниц, а не из случайного места. Разброс по X
  // тоже масштабируется шириной пучка, иначе на широком экране волоски падают
  // узкой полосой у линии среза.
  x = mix(x, uScissorX + (aDrop.z - 0.5) * 0.60 * uBundleK, layer);

  // Длинный fade-in: при высокой скорости короткий давал вспышку
  vLife = gate * smoothstep(0.0, 0.10, life) * (1.0 - smoothstep(0.45, 0.95, life));
  p = vec3(x, y, 0.65);
  sz *= 0.55 + aDrop.w * 0.85;
`,
});
// 60% базовых, 40% burst
{
  const a = cutBits.geometry.attributes.aExtra.array;
  const total = cutBits.geometry.attributes.aDrop.count;
  const baseCount = Math.round(total * 0.6);
  for (let i = 0; i < total; i++) a[i * 4] = i < baseCount ? 0 : 1;
  cutBits.geometry.attributes.aExtra.needsUpdate = true;
}

// ---- Этап 5: фиксация лаком, две системы частиц ------------------------
// 1) spray_fast — направленный быстрый мелкодисперсный поток (узкий конус)
// 2) spray_cloud — широкое медленное облако оседания
const jetFrag = `
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;
  float body = 1.0 - smoothstep(0.0, 1.0, r);
  gl_FragColor = vec4(vec3(0.92, 0.90, 0.84), body * vLife * 0.80 * uLacquer);
`;
const cloudFrag = `
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;
  // Рваный край — облако, а не шарик
  float ang = atan(uv.y, uv.x);
  float wob = 0.82 + 0.14 * (sin(ang * 3.0 + vSeed * 19.0) + sin(ang * 5.0 - vSeed * 41.0)) * 0.5;
  float body = 1.0 - smoothstep(wob * 0.20, wob, r / wob);
  gl_FragColor = vec4(vec3(0.95, 0.94, 0.90), pow(body, 1.5) * vLife * 0.26 * uLacquer);
`;

// Обе системы: частица летит от сопла к волосам и тормозит у них.
// dir — единичный вектор сопло→волосы (задаётся из tools.js).
const SPRAY_DIR = `
  float sp = fract(aDrop.y + uTime * (0.55 + aDrop.w * 0.5));
  // Торможение у сетки волос: ease-out — у сопла быстро, у волос почти
  // останавливается. Раньше тут было «travel + uDir*brake», то есть частицы
  // наоборот разгонялись к волосам.
  float travel = uJetLen * (1.0 - pow(1.0 - sp, 1.0 + uBrake * 9.0));
  p = uNozzle + uDir * travel;
  // Раствор по направлению потока (инерция): у конуса умеренный, у облака широкий
  p += (aDrop.xyz - 0.5) * uSpread * (0.25 + travel);
  // Веер в плоскости, перпендикулярной потоку: растёт с пройденным путём,
  // поэтому струя читается как широкий конус-arc, а не как линия.
  vec3 side = normalize(cross(uDir, vec3(0.0, 0.0, 1.0)));
  p += side * (aDrop.x - 0.5) * uSpread * 1.9 * (0.15 + travel);
  vLife = smoothstep(0.0, 0.06, sp) * (1.0 - smoothstep(uFadeEnd, 1.0, sp));
  p.y += (aDrop.x - 0.5) * uRise * sp;
`;
export const sprayFast = makePoints(qn('pfp_sprayfast', 1100, 0, 4000), jetFrag, {
  size: 0.16, sizePow: 1.2, sizeMin: 0.45,
  span: 1, depthTest: false, renderOrder: 6,
  vert: SPRAY_DIR,
});
export const sprayCloud = makePoints(qn('pfp_spraycloud', 520, 0, 4000), cloudFrag, {
  size: 0.85, sizePow: 1.8, sizeMin: 0.35,
  span: 1, depthTest: false, renderOrder: 5,
  vert: SPRAY_DIR,
});

// Параметры струи: длина, разлёт, подъём, торможение, где начинает гаснуть.
// Струя должна накрывать весь пучок (y от ~7.6 до ~-2.4), поэтому jetLen
// заметно больше ширины пучка, а fadeEnd близок к 1 — иначе частицы гаснут,
// не долетев до волос.
for (const [pts, jetLen, spread, rise, brake, fadeEnd] of [
  [sprayFast, 3.2, 0.70, 0.10, 0.06, 0.95],
  [sprayCloud, 4.0, 1.90, 0.55, 0.02, 1.00],
]) {
  Object.assign(pts.material.uniforms, {
    uNozzle: { value: new THREE.Vector3(0, 0, 0) },
    uDir: { value: new THREE.Vector3(-1, 0, 0) },
    uJetLen: { value: jetLen },
    uSpread: { value: spread },
    uRise: { value: rise },
    uBrake: { value: brake },
    uFadeEnd: { value: fadeEnd },
    uLacquer: { value: 0 },
  });
}

// Группы слоёв. Порядок объявления = порядок обхода в syncResolution.
export const washLayers = () => [bubbles, water, foamRivulet];
// Слои, чей поперечный радиус обязан ехать вместе с шириной пучка
export const bundleLayers = () => [...washLayers(), cutBits, glitter];
// Слои, которым нужен gl_PointSize в CSS-пикселях при resize
export const sizedLayers = () => [...washLayers(), steam, cutBits, sprayFast, sprayCloud];
