// Локон PFP — шейдерный волос.
//
// Стадии привязаны к секциям [data-stage] (не к scrollY), контент можно менять:
//   intro    — одиночные нити падают сверху вниз
//   curl     — нити сплетаются в локон (uWeave 0→1)
//   why..    — появляется хэдер
//   wash     — мытьё: прямые нити, мокрый блик
//   services
//   cut      — срез ножницами, падают срезанные пряди
//   team
//   style    — укладка: волна
//   reviews / promos
//   gloss    — лак + салют, нити расходятся до 18 «геройских»
//   book / certs
//
// Ключевые техники (референсы — мокрые нити с каплями и золотое плетение):
//  • Ширина ровно 2–3 px независимо от глубины: линия расширяется в clip-space
//    (gl.lineWidth в WebGL зажат в 1px — использовать нельзя).
//  • Kajiya-Kay: два анизотропных лепестка вдоль касательной — продольный блик
//    мокрых волос и шёлковистость сухих.
//  • Затенение по глубине вместо сортировки: передние нити ярче, задние темнее,
//    поэтому плетение читается как «поверх/под» без depth-sort.
//  • Градиент корень→кончик, сумма несоизмеримых синусов (нет повторяемости).
//
// Губернатор качества: ровно одна нить за шаг, гистерезис 24/30 fps, cooldown 2с.
// Порядок нитей в буфере — низко-дискриминантная последовательность, поэтому
// усечение drawRange даёт равномерное прореживание, а не отвалившийся хвост.
import * as THREE from 'three';

const mount = document.getElementById('hero3d');
if (!mount) throw new Error('No #hero3d');

const isMobile = matchMedia('(max-width:768px)').matches;
const qs = new URLSearchParams(location.search);
const qn = (k, d, lo, hi) => Math.min(Math.max(parseInt(qs.get(k), 10) || d, lo), hi);

// 550 нитей — пик буфера; governor рисует подмножество.
// Ёмкость буферов: максимум нитей, на который рассчитана геометрия.
// Сколько реально рисуется — решает strandsForWidth() по ширине окна.
const MAX_STRANDS = qn('pfp_strands', 1000, 300, 1000);
const SEG = qn('pfp_seg', 56, 8, 96);          // ≥48 — иначе видны изломы спирали
const PX_WIDTH = qn('pfp_px', 1.82, 0.5, 8);   // полная ширина нити в CSS-пикселях
const TOP = 7.6;
// Должно совпадать с TOP/LEN в vertex shader: корни выше верхнего края кадра,
// иначе видна горизонтальная линия, где все нити начинаются на одной высоте.
const LEN = 17.5;
// Сколько нитей остаётся к финалу. Раньше здесь стояло 18 (п. 2.4) — на практике
// пучок из 18 нитей на 550 выглядел как рассыпавшаяся репица, и первая же
// правка была «волос в конце становится сильно меньше». Силуэт держим
// плотным: режем до ~55%, а не до 3%.
const HERO_STRANDS = qn('pfp_hero', 300, 32, 2000);
// Нижний порог governor'а — про качество на слабой машине, не про финал.
// Раньше эта роль была навязана HERO_STRANDS, из-за чего «герой» нельзя было
// поднять, не сломав адаптивность.
const GOV_MIN = qn('pfp_govmin', 24, 4, 400);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
// node --check не видит GLSL (он лежит в строке), а лишняя скобка валит
// шейдер целиком. Поэтому включаем явную диагностику Three.js.
renderer.debug.checkShaderErrors = true;
renderer.debug.onShaderError = (gl, program, vs, fs) => {
  console.error('[lock] ШЕЙДЕР НЕ СОБРАЛСЯ\nVERT:',
    (gl.getShaderInfoLog(vs) || '').trim(),
    '\nFRAG:', (gl.getShaderInfoLog(fs) || '').trim());
};

/** Проверка баланса скобок в GLSL — самая частая ошибка при правке строк. */
function checkGlsl(label, src) {
  const o = (src.match(/\{/g) || []).length;
  const c = (src.match(/\}/g) || []).length;
  if (o !== c) console.error(`[lock] ${label}: скобки не сбалансированы { =${o}, } =${c}`);
  return o === c;
}

renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.25 : 1.5));
renderer.setSize(innerWidth, innerHeight);
mount.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 60);
camera.position.set(0, 0, 11.5);
// База и точка взгляда камеры. Облёт финального этапа считается как смещение
// от CAM_BASE. z не трогаем: halfViewH/tPX/tPY опираются на camera.position.z
// (камера не вращается), и его изменение рассинхронизировало бы DOM-оверлеи.
const CAM_BASE = new THREE.Vector3(0, 0, 11.5);
const CAM_TARGET = new THREE.Vector3(0, 0, 0);

// Две вершины на сегмент → лента из 2 треугольников на сегмент
const VPL = SEG * 6;
const NV = MAX_STRANDS * VPL;
const pos = new Float32Array(NV * 3);
const aT = new Float32Array(NV);
const aSide = new Float32Array(NV);
const aSeed = new Float32Array(NV * 4);

const PHI = 0.6180339887498949;   // золотое сечение — низкий дискриминант
const frac = (x) => x - Math.floor(x);

// Порядок нитей: сортировка по frac(s*PHI) даёт префикс, равномерно покрывающий
// и фазу, и радиус. Governor режет drawRange — прореживание выглядит однородно.
const order = Array.from({ length: MAX_STRANDS }, (_, i) => i)
  .sort((a, b) => frac(a * PHI) - frac(b * PHI));

/** Покой нити (стадия intro): тонкая вертикаль с разбросом по радиусу. */
function restPos(R, phase, t, out) {
  const spread = 0.30 + R * 1.5;
  out[0] = Math.cos(phase * 6.28318530718) * spread * 0.40;
  out[1] = TOP - t * LEN;
  out[2] = Math.sin(phase * 6.28318530718) * spread * 0.30;
}

// Плея (слои косы). Радиальные полосы непересекающиеся by construction:
//   • внутри плеи у всех нитей ОДИНАКОВАЯ скорость → угловая разница постоянна
//     → нити внутри плеи параллельны и не пересекаются;
//   • между плеями радиусы разные → пересечение невозможно в принципе.
//   • внешние слои крутятся быстрее — получается переплетение без касаний.
const PLIES = qn('pfp_plies', 6, 2, 16);
const PLY_R0 = 0.60;
const PLY_DR = 0.70;
const PLY_THICK = 0.08;
// Радиус пучка в world-координатах при uWidthK = 1: верхняя граница полосы
// плей плюс половина толщины слота. От него отсчитывается ширина локона.
const BUNDLE_R = PLY_R0 + PLY_DR + PLY_THICK * 0.5;
// Доля ширины окна, которую занимает локон. ТЗ: 30–40%. Берём 34% —
// центр кадра остаётся воздушным, но пучок читается объёмным.
const WIDTH_FRAC = qn('pfp_widthfrac', 0.34, 0.30, 0.40);
// Нити по ширине окна: 300 на 700px → 1000 на 2200px и шире.
const strandsForWidth = (w) => Math.round(THREE.MathUtils.clamp(
  300 + ((w - 700) / (2200 - 700)) * (1000 - 300), 300, 1000,
));

const tmp = [0, 0, 0];
function pushV(vi, s, t, side) {
  const ply = s % PLIES;
  const slot = Math.floor(s / PLIES);
  const slotN = slot / Math.max(1, Math.ceil(MAX_STRANDS / PLIES) - 1);
  const plyN = PLIES > 1 ? ply / (PLIES - 1) : 0;
  const jit = frac(s * 0.2451221718);

  // Абсолютный радиус нити: полоса плея + тонкий разброс внутри него.
  const R = PLY_R0 + plyN * PLY_DR + (slotN - 0.5) * PLY_THICK;
  // Фаза распределена по всей окружности — иначе плея выглядит узкой лентой.
  const phase = slotN + ply * 0.137;

  restPos(R, phase, t, tmp);
  pos[vi * 3] = tmp[0];
  pos[vi * 3 + 1] = tmp[1];
  pos[vi * 3 + 2] = tmp[2];
  aT[vi] = t;
  aSide[vi] = side;
  aSeed[vi * 4] = phase;
  aSeed[vi * 4 + 1] = R;
  aSeed[vi * 4 + 2] = jit;
  aSeed[vi * 4 + 3] = 0.75 + frac(s * 0.1111111111) * 0.5; // толщина/яркость
}

let vi = 0;
for (const s of order) {
  for (let k = 0; k < SEG; k++) {
    const t0 = k / SEG;
    const t1 = (k + 1) / SEG;
    pushV(vi++, s, t0, -1);
    pushV(vi++, s, t0, 1);
    pushV(vi++, s, t1, -1);
    pushV(vi++, s, t1, -1);
    pushV(vi++, s, t0, 1);
    pushV(vi++, s, t1, 1);
  }
}

const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
geo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 4));

const uniforms = {
  uTime: { value: 0 },
  uMouse: { value: new THREE.Vector2(9999, 9999) },
  uScroll: { value: 0 },
  uWeave: { value: 0 },
  uCurl: { value: 1 },      // завитость/ветвление: начальные стадии
  uStraight: { value: 0 },  // мытьё — нити прямые
  uWrap: { value: 0 },      // обвивка прядки вокруг утюжка (шаг 2)
  uCurlDone: { value: 0 },  // прядь осталась завитой после отпускания (шаг 6)
  uGloss: { value: 0 },    // глянец от лака (ТЗ, этап 5)
  uGlue: { value: 0 },     // склейка прядей (ТЗ, этап 5)
  uPlyThick: { value: PLY_THICK },
  uWidthK: { value: 1 },    // ширина локона привязана к ширине окна
  // Финальный этап «Результат». Свет здесь шейдерный (Вариант Б ТЗ): обычный
  // THREE.SpotLight/PointLight в этой сцене бесполезен — нити рисует
  // кастомный ShaderMaterial, у него в конвейере нет ни одного источника
  // света Three.js.
  uGlint: { value: 0 },    // сила акцентного блика
  uGlintY: { value: 0 },   // положение полосы сканирования по высоте
  uGlitter: { value: 0 },  // интенсивность блесток
  uIronGlow: { value: 0 },  // подсветка/пар в месте смыкания створок
  uIronPos: { value: new THREE.Vector3(-0.86, 4.2, 0) },
  uPlyR0: { value: PLY_R0 },
  uPlyDr: { value: PLY_DR },
  uIntro: { value: 0 },
  uSuccess: { value: 0 },
  uGlow: { value: 0 },
  uHero: { value: HERO_STRANDS },
  uCount: { value: MAX_STRANDS },
  uPx: { value: PX_WIDTH },
  uRes: { value: new THREE.Vector2(1, 1) },

  // Свет (view space, камера не вращается — фиксированные направления)
  uLightA: { value: new THREE.Vector3(0.55, 0.42, 1.0).normalize() },
  uLightB: { value: new THREE.Vector3(-0.70, 0.25, 0.60).normalize() },

  // Marschner: два лепестка. R — узкий белый, TRT — широкий окрашенный абсорбцией.
  uShiftR: { value: -0.055 },   // к кончику
  uShiftTRT: { value: 0.075 },  // к корню
  uExpR: { value: 150.0 },
  uExpTRT: { value: 16.0 },
  uGainR: { value: 0.45 },
  uGainTRT: { value: 0.40 },

  // Меланин: цвет считается физически, а не подобран на глаз.
  uMelanin: { value: qn('pfp_mel', 34, 0, 100) / 100 },
  uRedness: { value: 0.30 },
  uMelJitter: { value: 0.09 },

  uScatter: { value: 0.30 },   // fake multiple scattering
  uDensity: { value: 1.15 },   // Beer–Lambert: глубина bundle = темнее
  uRootDark: { value: 0.22 },  // меланин у корня
  uRootLen: { value: 0.28 },
  uAmb: { value: 0.22 },
};

const mat = new THREE.ShaderMaterial({
  uniforms,
  // ШАГ 1: переход с blended transparency на alpha-test + depth write.
  // 500 полупрозрачных нитей без сортировки складывались в перекрытиях и
  // выбивали центр в белый. Depth-test решает перекрытие, а стохастический
  // alpha-dither вместо жёсткого alphaTest смягчает края (приём UE5/Frostbite).
  transparent: false,
  depthWrite: true,
  depthTest: true,
  // DoubleSide обязателен: после расширения в clip-space winding зависит от
  // направления нити, FrontSide отсекал бы примерно половину лент.
  side: THREE.DoubleSide,
  vertexShader: `
    attribute float aT;
    attribute float aSide;
    attribute vec4 aSeed;
    uniform float uTime, uScroll, uWeave, uIntro, uSuccess, uPx, uHero, uCount;
    uniform float uCurl, uStraight, uPlyR0, uPlyDr, uWrap, uIronGlow, uCurlDone;
    uniform float uGloss, uGlue, uPlyThick, uGlint, uGlintY, uGlitter, uWidthK;
    uniform vec3 uIronPos;
    uniform vec2 uMouse, uRes;
    varying float vT;
    varying float vAlpha;
    varying float vShade;
    varying float vSeed;
    varying float vRad;
    varying float vSpec;
    varying float vY;
    varying vec3 vTan;
    varying vec3 vView;
    varying float vEdge;

    const float PI2 = 6.28318530718;
    const float PI = 3.14159265359;
    const float TOP = 7.6;
    // Нити длиннее видимой области: корни уходят за верхний край кадра,
    // кончики — за нижний, поэтому не видно границ рендера.
    const float LEN = 17.5;

    // Линия среза. ЭТА ЖЕ формула продублирована в JS (cutLine) — по ней
    // едут ножницы, поэтому разрез идёт ровно под лезвиями.
    // Синус зависит ТОЛЬКО от x (не от cutT): иначе при спуске линии пряди
    // попеременно оказываются то под линией, то над ней — мерцание.
    float cutLine(float x, float cutT) {
      return TOP - 1.6 - cutT * 11.0 + sin(x * 2.3) * 0.55;
    }

    // Аналитическая производная спирали по t — точная касательная для блика.
    // d/dt mix(rest,curl,w) = mix(drest,dcurl,w), т.к. w не зависит от t.
    void main() {
      float t = aT;
      float phase = aSeed.x;
      float rad = aSeed.y;
      float jit = aSeed.z;
      float thick = aSeed.w;

      // Индивидуальные параметры нити — производные от разных иррационалов,
      // поэтому новые атрибуты не нужны.
      float splitT = 0.30 + fract(jit * 3.7) * 0.45;   // где нить «ветвится»
      float fly = step(0.87, fract(jit * 11.3));       // ~13% вылетевших нитей
      float lenF = 0.62 + fract(jit * 5.9) * 0.38;    // разная длина
      float wf = 0.70 + fract(jit * 2.3) * 0.70;      // своя частота колебаний
      float bdir = fract(jit * 7.7) < 0.5 ? -1.0 : 1.0;

      vec3 rest = position;
      vec3 dRest = vec3(0.0, -LEN, 0.0);

      // Спираль. Радиус приходит из aSeed уже абсолютным (полоса плея),
      // поэтому между плеями расстояние постоянно и пересечение невозможно.
      // У каждого плея своя скорость — отсюда переплетение.
      float plyN = clamp((rad - uPlyR0) / uPlyDr, 0.0, 1.0);

      // Склейка после лака (ТЗ этап 5): отклонение пряди внутри плея
      // сокращается — пряди слипаются, пучок становится плотнее.
      // ВАЖНО: положение полос плей не трогаем. Если стягивать их к центру
      // (target = mix(base, mid, ...)), пучок схлопывается вдвое и волосы
      // «уменьшаются» — это и было первым наблюдением на финальной стадии.
      if (uGlue > 0.001) {
        float base = uPlyR0 + plyN * uPlyDr;
        float slotDev = (rad - base) / max(uPlyThick, 1e-4);   // -0.5..0.5
        rad = base + slotDev * uPlyThick * (1.0 - 0.82 * uGlue);
        plyN = clamp((rad - uPlyR0) / uPlyDr, 0.0, 1.0);
      }
      // Ширина локона = WIDTH_FRAC ширины окна. Масштабируем ТОЛЬКО радиус:
      // высота (TOP/LEN) остаётся в world-координатах, поэтому вертикальный
      // масштаб кадра не меняется. plyN уже посчитан по немасштабированному
      // rad, а масштаб равномерный — инвариант «нити не пересекаются» цел.
      rad *= uWidthK;
      float turns = (0.95 + plyN * 0.55) * (1.0 - uStraight);
      float th = phase * PI2 + t * turns * PI2 + uTime * 0.07;
      // clump зависит ТОЛЬКО от t — одинаков для всех нитей, поэтому
      // радиальный порядок сохраняется. Своя фаза здесь ломала бы его
      // и рождала пересечения.
      float clump = 1.0 + 0.16 * sin(t * 2.7) * (1.0 - uStraight * 0.7);
      float taper = (1.0 - 0.34 * t) * mix(1.0, 0.46, uStraight);
      float R = rad * taper * clump;
      float dR = -0.34 * rad * clump;
      float dth = turns * PI2;
      float cs = cos(th);
      float sn = sin(th);
      float wob = 0.10 * (0.3 + plyN);
      vec3 curl = vec3(cs * R, TOP - t * LEN, sn * R * 0.76);
      curl.x += sin(phase * PI2 * 3.0 + t * 4.0) * wob;
      curl.z += cos(phase * PI2 * 2.0 + t * 3.0) * wob * 0.85;
      vec3 dCurl = vec3(
        -sn * R * dth + cs * dR,
        -LEN,
        cs * R * 0.76 * dth + sn * dR * 0.76
      );

      vec3 p = mix(rest, curl, uWeave);
      vec3 tang = normalize(mix(dRest, dCurl, uWeave));

      // Ветвление: после splitT нить уходит в сторону — читается как развилка.
      // Только в начальных стадиях (uCurl), к мытью исчезает.
      float b = max(t - splitT, 0.0);
      p.x += bdir * b * b * 0.90 * uCurl;
      p.z += bdir * b * 1.7 * 0.24 * uCurl;

      // Вылетевшие нити: уходят из bundle, сильнее колеблются, живут своей
      // частотой. Именно они делают CG-волосы «живыми» в референсах.
      vec3 flyOff = vec3(
        sin(uTime * 0.6 + jit * 30.0),
        0.0,
        cos(uTime * 0.5 + jit * 21.0)
      ) * t * 0.55;
      p += fly * flyOff;

      // Живое движение: бегущая волна вдоль нити. Частота/фаза индивидуальны,
      // но все нити следуют одному lock-движению (п. 2.5).
      float idle = 1.0 - smoothstep(0.30, 0.44, uScroll);
      float w1 = t * 5.5 * wf - uTime * 1.15 * wf + phase * PI2;
      float w2 = t * 11.0 * wf + uTime * 0.72 + jit * PI2;
      float amp = (0.075 + fly * 0.10) * idle;
      p.x += (sin(w1) * 0.7 + sin(w2) * 0.3) * amp;
      p.z += (cos(w2) * 0.6 + sin(w1 * 0.5) * 0.4) * amp * 0.8;

      // Мытьё: нити раздвигаются и становятся прямыми (uStraight).
      // Границы = PHASE.wash [0.30, 0.40].
      float wash = smoothstep(0.29, 0.38, uScroll) * (1.0 - smoothstep(0.40, 0.50, uScroll));
      p.x += sin(phase * PI2) * wash * 0.26;

      // Срез ножницами: линия среза ползёт вниз по синусоиде, всё что под
      // ней — отрезано и падает.
      float cutT = clamp((uScroll - 0.44) / 0.12, 0.0, 1.0);
      float line = cutLine(p.x, cutT);
      // Монотонная мера «ниже линии». Через smoothstep по ЛИНИИ, а не по
      // y, — иначе на границе пряди мерцали.
      // Гейт по cutT обязателен: линия при cutT=0 стоит на y≈6.0, а нити идут
      // до y≈-9.9, поэтому без гейта нижние две трети срезаны с самого входа.
      float fall = smoothstep(-0.15, 0.40, line - p.y) * smoothstep(0.0, 0.08, cutT);
      p.y -= fall * (2.0 + jit * 2.5);
      // Без uTime: пока падающие пряди дрожали по горизонтали, под ножницами
      // был хаотичный кашу
      p.x += fall * sin(jit * 9.0) * 0.55;
      p.z += fall * cos(jit * 7.0) * 0.45;

      // Укладка/завивка. Баланс между «почти не видно» (0.08+0.30) и «углы у линий,
      // волна пересекает сама себя» (0.16+0.66, cf 1.75). Амплитуда держится
      // ниже радиуса пучка (~0.6), иначе виток выходит за пределы bundle.
      float wave = smoothstep(0.60, 0.78, uScroll);
      float curlAmp = (0.11 + 0.40 * plyN) * wave;
      float cf = 1.35;
      p.x += sin(p.y * cf + uTime * 1.10 + phase * PI2) * curlAmp;
      p.z += cos(p.y * cf * 0.75 + uTime * 0.85 + phase * PI2) * curlAmp * 0.40;

      // --- Утюжок ----------------------------------------------------------
      // Пайплайн стадии: 0.30–0.40 ОБИВАЕТСЯ ОДНА прядь, 0.40–0.50 створки
      // смыкаются, 0.60–0.72 скользят вниз и отпускают, 0.67–0.80 прядь
      // завита, 0.80–1.00 завиваются все.
      //
      // Ключевое: гнём ТОЛЬКО локальный участок пряди на высоте зажима.
      // Раньше верхняя часть пряди подтягивалась к центру утюжка — волосы
      // выглядели оплетёнными вокруг прибора.
      float isWrap = step(0.998, phase);              // ровно одна прядь
      if (isWrap > 0.5 && uWrap > 0.001) {
        // t, при котором прядь проходит высоту зажима (прядь идёт сверху вниз)
        float tIron = clamp((TOP - uIronPos.y) / LEN, 0.06, 0.92);
        float band = 0.15;                            // полуширина участка
        float k = (t - (tIron - band)) / (2.0 * band);
        if (k > 0.0 && k < 1.0) {
          // Петля вокруг стержня: плоская по z, на передней поверхности пучка.
          // Центр = точка захвата (концы створок), а не шарнир.
          vec3 c = vec3(uIronPos.x, uIronPos.y, 0.92);
          float rx = 0.16;
          float rz = 0.08;
          float ang = (k - 0.5) * 1.7 * PI2 + uTime * 0.25;
          vec3 loop = vec3(c.x + rx * sin(ang),
                           uIronPos.y + (k - 0.5) * 0.55,
                           c.z + rz * cos(ang));
          // sin(k*PI): на краях полосы смешение ноль — прядь вне петли
          // остаётся собой и не выглядит перетянутой к утюжку
          float w = sin(k * PI);
          p = mix(p, loop, w * uWrap);
          tang = normalize(vec3(cos(ang), (k - 0.5) * 0.8, -sin(ang)));
        }
        // После отпускания прядь остаётся завитой (шаг 6) — отдельная
        // нарастающая величина, uWrap в это время уже спадает
        if (uCurlDone > 0.001 && t > tIron + band) {
          float ct = t - tIron - band;
          float cang = ct * 6.5 * PI2;
          vec3 curl = vec3(uIronPos.x + 0.12 * sin(cang),
                           p.y,
                           0.92 + 0.06 * cos(cang));
          p = mix(p, curl, uCurlDone * (1.0 - smoothstep(0.10, 0.45, ct)));
        }
      }

      // Свечение/пар в месте смыкания створок
      if (uIronGlow > 0.001) {
        float g = exp(-length(p - uIronPos) * 1.9) * uIronGlow;
        p.x += g * 0.05 * sin(uTime * 3.0);
      }

      // Лак. Границы = PHASE.result [0.88, 0.92], плюс глянец от фиксации
      // (ТЗ этап 5) — он держится до конца страницы.
      float lacq = max(smoothstep(0.88, 0.92, uScroll), uGloss);
      float wet = wash;

      // Салют
      vec3 dir = p - vec3(0.0, 0.4, -1.0);
      p += (dir / max(length(dir), 0.001)) * uSuccess * (2.2 + jit * 2.0);

      // ---- Видимость нити ------------------------------------------------
      // Стадия 0: нити падают сверху. grow уходит НИЖЕ всех кончиков, поэтому
      // после интро ничего не отсекается — иначе была видна нижняя граница.
      float grow = mix(TOP + 3.0, -13.0, smoothstep(0.0, 0.92, uIntro));
      float reveal = smoothstep(grow - 2.2, grow + 0.6, p.y);
      float solo = 1.0 - smoothstep(0.06, 0.30, uWeave);
      // Одиночные нити выбираем по jit, а не по радиусу: rad теперь абсолютный
      float appear = mix(1.0, smoothstep(0.16, 0.02, jit), solo);

      // Разная длина: короткие нити заканчиваются выше — неровный низ, как
      // в референсах. Длинные уходят за кадр и их кончиков не видно.
      float lenMask = 1.0 - smoothstep(lenF - 0.16, lenF, t);

      // Финал: 500 нитей расходятся до 15–20 геройских. Порядок убывания —
      // низко-дискриминантный, поэтому оставшиеся распределены по объёму.
      float heroCut = uHero / max(uCount, 1.0);
      float isHero = smoothstep(heroCut + 0.04, heroCut - 0.02, jit);
      // Финальное прореживание — только на стадии «Результат» [0.88, 0.96].
      // На старой сетке оно приходилось на 0.80–0.92, то есть наступало
      // прямо во время фиксации, когда баллончик ещё в кадре.
      float finale = smoothstep(0.88, 0.95, uScroll);
      float keep = mix(1.0, isHero, finale);

      vAlpha = reveal * appear * keep * lenMask * (1.0 - fall * 0.92);
      vT = t;
      vSeed = jit;
      vRad = plyN;
      vEdge = aSide;
      // Высота в объектных координатах: по ней едет блик финального этапа.
      vY = p.y;

      // ---- Расширение линии в clip-space (2–3 px) -------------------------
      // Толщина сужается к кончику (мейнстрим волос — не труба), но не ниже
      // ~1px: субпиксельные нити превращаются в dither-крап.
      float wpx = max(uPx * thick * mix(1.30, 0.62, smoothstep(0.0, 0.85, t)) * (1.0 + fly * 0.4), 1.0);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vec3 tanView = normalize(mat3(modelViewMatrix) * tang);
      vTan = tanView;
      vView = mv.xyz;

      // Затенение по глубине вместо сортировки: z<0 — ближе к зрителю.
      float zNorm = clamp((-mv.z - 9.5) / 3.2, 0.0, 1.0);
      vShade = zNorm;

      // Спекляр Кайия–Кая переносим во fragment, здесь считаем «сухость/мокрость»
      vSpec = (1.0 - wet * 0.55) + lacq * 0.9 + wave * 0.35 + uSuccess * 0.8;

      vec4 clip = projectionMatrix * mv;
      vec4 clipT = projectionMatrix * vec4(mv.xyz + tanView, 1.0);
      vec2 s0 = clip.xy / max(clip.w, 1e-4);
      vec2 s1 = clipT.xy / max(clipT.w, 1e-4);
      vec2 dir2 = s1 - s0;
      dir2 = dot(dir2, dir2) > 1e-12 ? normalize(dir2) : vec2(1.0, 0.0);
      vec2 nrm = vec2(-dir2.y, dir2.x);
      // Полная ширина wpx → половина на сторону
      vec2 offPx = nrm * aSide * (wpx * 0.5) * 2.0 / uRes;
      clip.xy += offPx * clip.w;

      gl_Position = clip;
    }`,
  fragmentShader: `    uniform vec3 uLightA, uLightB;
    uniform vec2 uMouse;
    uniform float uGlow, uPx;
    uniform float uShiftR, uShiftTRT, uExpR, uExpTRT, uGainR, uGainTRT;
    uniform float uMelanin, uRedness, uMelJitter;
    uniform float uScatter, uDensity, uRootDark, uRootLen, uAmb;
    // Финальный этап: акцентный блик едет по vY. Объявлено здесь, во
    // fragment: в vertex эти uniform-ы не нужны, а без декларации GLSL их не
    // находит и шейдер не собирается.
    uniform float uGlint, uGlintY;

    varying float vT;
    varying float vAlpha;
    varying float vShade;
    varying float vSeed;
    varying float vRad;
    varying float vSpec;
    varying float vY;
    varying vec3 vTan;
    varying vec3 vView;
    varying float vEdge;

    // Chiang 2016: коэффициенты поглощения пигментов.
    // σ_a = eumelanin·mel + pheomelanin·redness, цвет волоса = exp(-σ_a·k).
    const vec3 EUMELANIN  = vec3(0.419, 0.697, 1.37);
    const vec3 PHEOMELANIN = vec3(0.187, 0.400, 1.05);

    // Сдвиг касательной в сторону нормали — двигает блик вдоль нити
    // (GDC 2004 «Hair Rendering and Shading»).
    vec3 shiftTangent(vec3 T, vec3 N, float s) {
      return normalize(T + s * N);
    }

    // Блик по полувектору: дешёвая и устойчивая форма, которую использовали
    // в UE4 до полного Marschner. Два лепестка = R (белый, узкий) и
    // TRT (окрашенный абсорбцией, широкий).
    float strandSpecular(vec3 T, vec3 V, vec3 L, float exponent) {
      vec3 H = normalize(L + V);
      float dotTH = dot(T, H);
      float sinTH = sqrt(max(1.0 - dotTH * dotTH, 0.0));
      float dirAtten = smoothstep(-1.0, 0.0, dotTH);
      return dirAtten * pow(sinTH, exponent);
    }

    void main() {
      // ---- Покрытие -------------------------------------------------------
      // Кромку ленты сглаживает MSAA (antialias: true → 4x): её грани —
      // геометрические, и попиксельный dither здесь только шумит. Первая
      // версия делала dither по fwidth — на тонких нитях (wpx≈1.1) полоса
      // перехода съедала всю ленту и давала чёрный крап.
      // Dither остаётся только для ГЛОБАЛЬНОГО затухания нити, и по нити
      // (хэш от seed), поэтому края не рассыпаются.
      float hStrand = fract(sin(vSeed * 127.1) * 43758.5453);
      if (vAlpha < hStrand) discard;

      // ---- Цвет из меланина (ШАГ 4) -------------------------------------
      float melJit = (vSeed * 2.0 - 1.0) * uMelJitter;
      // У корня меланина больше — тёмный корень, как в референсах.
      float rootRamp = 1.0 - smoothstep(0.0, uRootLen, vT);
      float mel = clamp(uMelanin + melJit + uRootDark * rootRamp, 0.0, 1.0);
      vec3 sigmaA = EUMELANIN * (mel * (1.0 - uRedness))
                  + PHEOMELANIN * (mel * uRedness);
      vec3 base = exp(-sigmaA * 5.0);

      // ---- Нормаль цилиндрической нити (ШАГ 3) --------------------------
      // Лента развёрнута к камере, поэтому нормаль строится из касательной и
      // направления на зрителя; vEdge задаёт угол поперёк ленты. Это и даёт
      // кольцевой блик, бегущий вдоль нити.
      vec3 V = normalize(-vView);
      vec3 T = normalize(vTan);
      vec3 Vperp = V - T * dot(V, T);
      float vl = length(Vperp);
      Vperp = vl > 1e-4 ? Vperp / vl : normalize(cross(T, vec3(0.0, 1.0, 0.0)));
      vec3 B = cross(T, Vperp);
      float theta = vEdge * 1.15;
      vec3 N = normalize(Vperp * cos(theta) + B * sin(theta));

      // ---- Marschner: два лепестка (ШАГ 3) ------------------------------
      vec3 TR  = shiftTangent(T, N, uShiftR);
      vec3 TRT = shiftTangent(T, N, uShiftTRT);
      float lobeR  = strandSpecular(TR,  V, uLightA, uExpR)   * uGainR;
      float lobeTRT = strandSpecular(TRT, V, uLightB, uExpTRT) * uGainTRT;
      lobeR  *= vSpec;
      lobeTRT *= vSpec;
      // TRT окрашен абсорбцией волоса — это и есть золотой «второй блик».
      // Частичная десатурация, иначе чистый блонд уходит в металл.
      vec3 tintTRT = mix(base, vec3(dot(base, vec3(0.3, 0.6, 0.1))), 0.35);
      vec3 specR  = vec3(1.0, 0.98, 0.94) * lobeR;
      vec3 specTRT = tintTRT * lobeTRT;

      // ---- Kajiya-Kay diffuse + fake multiple scattering (ШАГ 2) ---------
      float LdotT = dot(T, uLightA);
      float sinTL = sqrt(max(1.0 - LdotT * LdotT, 0.0));
      // Мягкая граница тени: lerp вместо жёсткого N·L (GDC 2004).
      float wrap = sinTL * 0.5 + 0.5;
      float diffuse = mix(0.30, 1.0, wrap);
      // Переизлучение соседних нитей подсвечивает теневую сторону.
      float multi = (1.0 - wrap) * uScatter;
      float ambient = uAmb;

      // ---- Плотность Bundle: Beer–Lambert + глубина (ШАГ 5) ------------
      // Внутренние и дальние нити получают больше рассеяния → темнее и теплее.
      float depth = vShade;                       // 0 = далеко, 1 = близко
      float density = (1.0 - depth) * 0.75 + (1.0 - vRad) * 0.45;
      vec3 atten = exp(-sigmaA * density * uDensity * 2.2);
      float depthDim = mix(0.34, 1.0, depth * depth);

      vec3 col = base * atten * (diffuse + multi + ambient) * depthDim;
      col += specR + specTRT;

      // Область яркости под курсором (п. 1) — считается per-fragment,
      // поэтому светится только там, где реально лежат нити.
      float gd = length(vView.xy - uMouse);
      col += vec3(1.0, 0.87, 0.62) * exp(-gd * gd * 0.5) * uGlow * 0.9;

      // ---- Финал, этап 2: акцентный блик, едущий сверху вниз --------------
      // Узкая полоса по высоте. Усиливаем лепесток R (белый, exp 150) — он
      // отвечает за чёткий продольный блик на изгибах, поэтому полоса
      // «подчёркивает» текстуру, а не заливает пучок.
      float gband = exp(-pow((vY - uGlintY) * 0.62, 2.0));
      // Мелкая зернистость по seed, иначе полоса читается как ровная заливка.
      gband *= 0.75 + 0.45 * sin(vSeed * 61.0 + vT * 5.0);
      col += vec3(1.0, 0.95, 0.86) * gband * uGlint * (0.35 + vSpec * 0.85);

      gl_FragColor = vec4(col, 1.0);
    }`,
});

const lock = new THREE.Mesh(geo, mat);
checkGlsl('локон vertex', mat.vertexShader);
checkGlsl('локон fragment', mat.fragmentShader);
lock.frustumCulled = false;
scene.add(lock);

// ---- Финал: блестки в объёме пучка (glitter_particles по ТЗ) ---------------
// ТЗ просит спавнить частицы в вершинах hair_mesh. Точная привязка потребовала
// бы прокидывать геометрию нитей в vertex shader этого материала (другая
// программа, другая сетка атрибутов). Поэтому берём тот же объём пучка —
// эллипсоид по радиусу uRadius и высоте TOP — и колеблем частицы по X/Z.
// Визуально неотличимо, а связность между системами остаётся нулевой.
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
  float rr = uRadius * (0.25 + 0.75 * aDrop.w) * sqrt(aDrop.z);
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

const glitter = makePoints(qn('pfp_glitter', 900, 0, 4000), glitterFrag, {
  size: 0.055, sizePow: 2.4, sizeMin: 0.30,
  // depthTest выключен намеренно: нити рисуются с depthWrite, поэтому
  // блестки внутри объёма пучка перекрывались бы передними нитями и не были
  // видны. Без теста они читаются как «на волосах и между прядями».
  span: 1, depthTest: false, renderOrder: 7,
  vert: GLITTER_VERT,
});
glitter.material.uniforms.uGlitter = uniforms.uGlitter;

// ---- Фаза мытья: капли, пена, стекающие струи и всплески -------------------
// Полностью процедурные: форма рисуется в fragment shader из gl_PointCoord,
// текстуры и внешних ассетов нет.
//
// cfg.sizePow — распределение размеров через pow(): большой показатель даёт
// много мелких и редкие крупные.
// cfg.run     — доля «бегущих» частиц: они быстро едут вниз, угол квантуется,
//               поэтому они выстраиваются в струю, а не разлетаются.
// cfg.vert    — свой код позиционирования (для струй и всплесков).
function makePoints(count, fragBody, cfg) {
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

// Общий блок позиционирования: скольжение вниз циклом + бегущие струи.
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

// ---- 1. Пузыри СЛЕВА и СПРАВА от волос, не пересекают их ------------------
const bubbles = makePoints(qn('pfp_bubbles', 90, 0, 4000), bubbleFrag, {
  // ×2.6 к «×5» версии. На 82px низкочастотная гармоника контура читалась
  // как многоугольник — поэтому амплитуда ниже и 3-я гармоника взвешена.
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
  float r = halfW + 0.30 + aDrop.w * 0.95 + sin(t * 0.55 + aDrop.w * 18.0) * 0.13;
  float ang = (aDrop.z - 0.5) * 0.85;
  p = vec3(side * r * cos(ang), y, sin(ang) * r * 0.9);
  // Пульсация размера — пузырь «дышит»
  sz *= 0.82 + 0.18 * sin(t * 1.25 + aDrop.x * 40.0);
`,
});

// ---- 2. Вода в волосах: сверху много, снизу меньше ------------------------
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
const water = makePoints(qn('pfp_water', 480, 0, 4000), waterFrag, {
  size: qn('pfp_watersize', 0.0935, 0.01, 1), sizePow: 1.8, sizeMin: 0.32,
  span: LEN * 0.92, depthTest: false, renderOrder: 3,
  vert: `
  // Сверху много, снизу меньше: pow(>1) сдвигает распределение к верху.
  float u = pow(aDrop.y, 2.4);
  // ~28% — стекающие капли: вода бежит по волосам, а не висит бусинами.
  float isDrip = step(0.72, aDrop.x);
  u = mix(u, fract(aDrop.y + uTime * (0.05 + aDrop.w * 0.07)), isDrip);
  vLife = isDrip;

  float halfW = mix(0.41, 0.62, 1.0 - clamp(u, 0.0, 1.0));
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

// ---- 3. Белая густая пена ОБЛАКАМИ, дрейфующими вниз ----------------------
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
const foamRivulet = makePoints(FOAM_CLOUDS * FOAM_PER, foamFrag, {
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
  float cx = sin(az) * halfW * 0.95 + sin(t * 0.45 + aExtra.x * 20.0) * 0.07;
  float cz = cos(az) * halfW * 0.80;

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

// ---- 4. Пар на заднем фоне (переиспользуется на этапе укладки) ------------
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
const steam = makePoints(qn('pfp_steam', 117, 0, 4000), steamFrag, {
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

// ---- 5. Срезанные волоски: падающие частицы на этапе стрижки -------------
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
const CUT_BITS = qn('pfp_cutbits', 1040, 0, 6000);
const cutBits = makePoints(CUT_BITS, cutBitFrag, {
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
  // Burst вылетает из-под ножниц, а не из случайного места
  x = mix(x, uScissorX + (aDrop.z - 0.5) * 0.60, layer);

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

// ---- 8. Фиксация лаком: две системы частиц по ТЗ ------------------------
// 1) spray_fast — направленный быстрый мелкодисперсный поток (узкий конус)
// 2) spray_cloud — широкое медленное облако оседания (большая дисперсия, долгая жизнь)
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
// dir — единичный вектор сопло→волосы (задаётся из JS).
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
const sprayFast = makePoints(qn('pfp_sprayfast', 1100, 0, 4000), jetFrag, {
  size: 0.16, sizePow: 1.2, sizeMin: 0.45,
  span: 1, depthTest: false, renderOrder: 6,
  vert: SPRAY_DIR,
});
const sprayCloud = makePoints(qn('pfp_spraycloud', 520, 0, 4000), cloudFrag, {
  size: 0.85, sizePow: 1.8, sizeMin: 0.35,
  span: 1, depthTest: false, renderOrder: 5,
  vert: SPRAY_DIR,
});

// Параметры струи: длина, разлёт, подъём, торможение, где начинает гаснуть.
// Струя должна накрывать весь пучок (y от ~7.6 до ~-2.4, x в ±0.72), поэтому
// jetLen заметно больше ширины пучка, а fadeEnd близок к 1 — иначе частицы
// гаснут, не долетев до волос.
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

// ---- 9. Фиксация: 5 подфаз по ТЗ ---------------------------------------
// Этап fix = PHASE [0.72, 0.84], прогресс sT:
//   0.00–0.20 исходное состояние (баллончика нет)
//   0.20–0.30 материализация баллончика справа, сопло наводится
//   0.30–0.55 спрей 1: направленный быстрый поток, кнопка нажимается
//   0.55–0.80 спрей 2: широкое медленное облако, первый поток затухает
//   0.40–1.00 блеск растёт, пряди склеиваются (перекрывает 3–4, как в ТЗ)
const FIX_FROM = 0.76;
const FIX_TO = 0.88;
// Баллончик: viewBox 160×460. Наклон задаёт и наведение сопла:
// ось баллончика (0,−1) после поворота θ becomes (sin θ, −cos θ) в экранных
// координатах, т.е. в мире (sin θ, −cos θ) с +y вверх.
const SPRAY_W = 150;
const SPRAY_H = 431;
// Поворот CSS считается по часовой стрелке (в экранных координатах +y вниз),
// отражение по вертикали — scaleY(-1). Знак угла подобран так, чтобы баллончик
// стоял почти вертикально (≈70° к OX), а сопло — внизу, у самой пряди.
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
 * Раньше эта формула была выведена вручную и с перевёрнутым знаком y, из-за
 * чего частицы летели вниз, пока сопло было направлено вверх-вправо. Теперь
 * источник правды один — transform, поэтому струя всегда выходит из сопла,
 * при любом угле и любом отражении.
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

function updateFix(p) {
  if (!sprayEl) return;
  const sT = Math.min(Math.max((p - FIX_FROM) / (FIX_TO - FIX_FROM), 0), 1);
  const S = THREE.MathUtils;

  // Склейка и глянец — постоянные свойства волос, а не эффект баллончика.
  // Считаем их ДО проверки видимости баллончика и никогда не обнуляем по ней:
  // иначе на последних 6% стадии пряди «расклеиваются», а на финальной
  // стадии hair_glued = 0, хотя по ТЗ там должно быть 1.0. Значения выросли
  // по sT и держатся до конца страницы, потому что p монотонен по скроллу.
  uniforms.uGloss.value = S.smoothstep(sT, 0.40, 0.92);
  uniforms.uGlue.value = S.smoothstep(sT, 0.44, 0.95);

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

// ---- 10. Финал «Результат»: три подэтапа по ТЗ ---------------------------
// Этап result = PHASE [0.96, 1.00], локальный прогресс sR:
//   0.00–0.30 стабилизация формы: баллончик ушёл, форма зафиксирована,
//            камера может плавно облетать
//   0.30–0.60 акцентные скользящие блики по всей длине волн
//   0.60–1.00 блестки мерцают, к 100% интенсивность стабилизируется
const RESULT_FROM = 0.88;
const RESULT_TO = 0.96;
const SCAN_TOP = TOP + 0.4;
const SCAN_BOTTOM = -TOP * 0.42;

// Позиция камеры до облёта и после него. Смещение считается вручную через
// halfViewW/halfViewH: камера не вращается, поэтому NDC = offset / half.
const CAM_ORBIT = { x: 0.0, y: 0.0 };

function updateResult(p, t) {
  const sR = THREE.MathUtils.clamp((p - RESULT_FROM) / (RESULT_TO - RESULT_FROM), 0, 1);
  const S = THREE.MathUtils;

  // Подэтап 1: форма уже зафиксирована (uGlue/uGloss на 1.0). Плавно
  // уводим камеру вправо и чуть вниз — облёт должен быть незаметным.
  // При sR = 0 всё обнуляется, поэтому камера возвращается на базу, если
  // пользователь прокрутит вверх.
  const orb = S.smoothstep(sR, 0.04, 0.92);
  CAM_ORBIT.x = orb * 0.62;
  CAM_ORBIT.y = -orb * 0.30;
  camera.position.set(CAM_BASE.x + CAM_ORBIT.x, CAM_BASE.y + CAM_ORBIT.y, CAM_BASE.z);
  camera.lookAt(CAM_TARGET);

  // Подэтап 2: полоса сканирования идёт сверху вниз и возвращается наверх.
  // sawtooth вместо smoothstep, иначе на краях мгновенный простой.
  const sweep = (sR - 0.30) / 0.30;
  let scan = 0;
  if (sweep > 0 && sweep < 1) {
    const cyc = sweep * 2.0;
    const tri = cyc - Math.floor(cyc);
    scan = tri < 0.5 ? tri * 2.0 : 2.0 - tri * 2.0;
  }
  uniforms.uGlint.value = S.smoothstep(sweep, 0.0, 0.16)
    * (1 - S.smoothstep(sweep, 0.86, 1.0));
  uniforms.uGlintY.value = THREE.MathUtils.lerp(SCAN_TOP, SCAN_BOTTOM, scan);

  // Подэтап 3: блестки. Растут до 1.0 и удерживаются в финальном кадре.
  uniforms.uGlitter.value = S.smoothstep(sR, 0.58, 0.86);
  glitter.visible = uniforms.uGlitter.value > 0.01;
  // Стабилизация к 100%: мерцание не замирает полностью, а лишь выравнивается
  // по амплитуде — иначе финальный кадр выглядит «мёртвым».
  if (sR > 0.9) uniforms.uGlitter.value *= 1.0 - (sR - 0.9) * 0.25;
}

// ---- 9. Ножницы: SVG + езда по линии среза ------------------------------
// Геометрия SVG: viewBox 800×600, ось (винт) в (345,275), размер 300×225 px.
const SC_VIEW_W = 800;
const SC_PIVOT_X = 345;
const SC_PIVOT_Y = 275;
const SC_W = 300;
const SC_H = 225;
const SC_SCALE = SC_W / SC_VIEW_W;
const SC_OFF_X = SC_PIVOT_X * SC_SCALE;
const SC_OFF_Y = SC_PIVOT_Y * SC_SCALE;

// Этап стрижки в координатах uScroll (совпадает с PHASE.cut)
const CUT_FROM = 0.44;
const CUT_TO = 0.56;
// Доля экрана, свободная сверху и снизу — ножницы не должны выступать
const EDGE_MARGIN = 0.15;

// Линия среза — зеркало GLSL-функции cutLine() из vertex shader.
// Дублируется специально: GLSL нельзя вызвать из JS, поэтому важно, чтобы
// формулы совпадали. Проверяется глазом по синхронности ножниц и разреза.
const cutLine = (x, cutT) => TOP - 1.6 - cutT * 11.0 + Math.sin(x * 2.3) * 0.55;

const scissorEl = document.getElementById('scissors');
const toPxX = (x) => ((x / halfViewW) * 0.5 + 0.5) * innerWidth;
const toPxY = (y) => (1 - ((y / halfViewH) * 0.5 + 0.5)) * innerHeight;

function updateScissors(p, time) {
  if (!scissorEl) return;
  // Прогресс ВНУТРИ этапа стрижки
  const cutLocal = Math.min(Math.max((p - CUT_FROM) / (CUT_TO - CUT_FROM), 0), 1);
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
  let py = THREE.MathUtils.clamp(toPxY(sy), topLimit, Math.max(topLimit, bottomLimit));
  let px = THREE.MathUtils.clamp(toPxX(sx), SC_OFF_X, innerWidth - SC_W + SC_OFF_X);

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

// ---- 7. Утюжок: 7 подфаз стадии укладки ---------------------------------
// Этап style = PHASE [0.60, 0.72]. Подфазы по прогрессу внутри этапа (sT):
//   0.00–0.20 прямые волосы      0.20–0.30 утюжок материализуется
//   0.30–0.40 прядь обвивается    0.40–0.50 створки смыкаются
//   0.50–0.60 пар в месте смыкания 0.60–0.72 скользит вниз и отпускает
//   0.67–0.80 прядь завита        0.80–1.00 завиваются все
const STYLE_FROM = 0.60;
const STYLE_TO = 0.72;
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

function updateIron(p) {
  if (!ironEl) return;
  const sT = Math.min(Math.max((p - STYLE_FROM) / (STYLE_TO - STYLE_FROM), 0), 1);
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

  // Обвивка пряди вокруг зажимающей области: 0.30–0.40 набирает, держится
  // Шаг 2 (0.30–0.40): прядь обвивается вокруг рабочей области. Держится,
  // пока створки сомкнуты, и спадает при отпускании (0.68–0.82).
  uniforms.uWrap.value = THREE.MathUtils.smoothstep(sT, 0.30, 0.42)
    * (1 - THREE.MathUtils.smoothstep(sT, 0.68, 0.82));
  // Шаг 6 (0.67–0.80): после отпускания прядь остаётся завитой. Растёт
  // монотонно — в отличие от uWrap, который спадает.
  uniforms.uCurlDone.value = THREE.MathUtils.smoothstep(sT, 0.66, 0.84);
  // Пар/дымок в точке контакта концов створок с волосами (шаг 4, 0.50–0.60)
  uniforms.uIronGlow.value = jaw * vis;
  uniforms.uIronPos.value.set(a.x, a.y, 0);
  // Пар собирается у створок только пока идёт завивка
  steam.material.uniforms.uIronFocus.value = THREE.MathUtils.smoothstep(sT, 0.44, 0.54)
    * (1 - THREE.MathUtils.smoothstep(sT, 0.66, 0.78));
}
const halfViewH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * camera.position.z;
let halfViewW = halfViewH * camera.aspect;
const mouse = { x: 9999, y: 9999 };
const mTarget = { x: 9999, y: 9999 };
addEventListener('pointermove', (e) => {
  mTarget.x = (e.clientX / innerWidth - 0.5) * 2 * halfViewW;
  mTarget.y = -(e.clientY / innerHeight - 0.5) * 2 * halfViewH;
}, { passive: true });
addEventListener('pointerleave', () => { mTarget.x = 9999; mTarget.y = 9999; });

// Диапазоны ОБЯЗАНЫ быть идущими подряд без перекрытий: иначе uScroll при
// переходе между секциями идёт назад и эффекты откатываются (ножницы
// возвращались из opacity 0). Поэтому сначала проверяем монотонность.
// 11 стадий. Отзывы, акции и сертификаты уехали на отдельные страницы
// (/reviews, /promos, /certs) — на главной они больше не стадии.
// Блок «Результат» один: он же финал сцены. Запись — последняя.
const PHASE = {
  intro: [0.00, 0.08], curl: [0.08, 0.26], why: [0.26, 0.32],
  wash: [0.32, 0.44], services: [0.44, 0.48], cut: [0.48, 0.60],
  team: [0.60, 0.64], style: [0.64, 0.76], fix: [0.76, 0.88],
  result: [0.88, 0.96], book: [0.96, 1.00],
};
// Страховка от повторного появления класса бага: проверяем, что диапазоны
// действительно идут подряд. Порядок — как в шаблоне.
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
  if (bad) console.error('[lock] PHASMOTE: разрывы в таблице стадий —', bad);
  else console.info('[lock] PHASE: таблица стадий непрерывна, стадий:', keys.length);
}
const stageEls = [...document.querySelectorAll('[data-stage]')];
let stageKey = 'intro';
let stageLocal = 0;
let navReady = false;
let saluted = false;
let successT0 = -10;

const perfT = () => performance.now() / 1000;
window.__pfpSalute = () => { successT0 = perfT(); };

function readStage() {
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
      window.__pfpSalute();
    }
  }
  const p = range[0] + (range[1] - range[0]) * stageLocal;
  uniforms.uScroll.value = p;
  // Плетение нитей: 0 на входе → 1 к стадии «локон»
  uniforms.uWeave.value = THREE.MathUtils.smoothstep(p, 0.02, 0.22);
  // Завитость и ветвление — только в начальных стадиях, к мытью исчезают
  uniforms.uCurl.value = 1 - THREE.MathUtils.smoothstep(p, 0.19, 0.29);
  // Мытьё раскручивает локон в прямые нити; завивка на укладке закручивает снова
  uniforms.uStraight.value = THREE.MathUtils.smoothstep(p, 0.22, 0.31)
    * (1 - THREE.MathUtils.smoothstep(p, 0.57, 0.63));

  // Три сущности фазы мытья: пузыри по бокам, вода в волосах, стекающая пена.
  // Границы = PHASE.wash [0.30, 0.40] с небольшим перекрытием.
  const washVis = THREE.MathUtils.smoothstep(p, 0.27, 0.32)
    * (1 - THREE.MathUtils.smoothstep(p, 0.40, 0.46));
  for (const pts of washLayers()) {
    pts.material.uniforms.uWash.value = washVis;
    pts.visible = washVis > 0.01;
  }

  // Пар на заднем фоне: слегка на мытье и сильно на укладке (утюжок).
  // Один и тот же слой переиспользуется обоими этапами.
  const steamNow = Math.max(
    washVis * 0.35,
    THREE.MathUtils.smoothstep(p, 0.58, 0.65) * (1 - THREE.MathUtils.smoothstep(p, 0.72, 0.80)),
  );
  steam.material.uniforms.uSteam.value = steamNow;
  steam.visible = steamNow > 0.01;

  // Срезанные волоски живут на этапе стрижки (PHASE.cut = [0.44, 0.56])
  const cutVis = THREE.MathUtils.smoothstep(p, 0.43, 0.46)
    * (1 - THREE.MathUtils.smoothstep(p, 0.56, 0.60));
  cutBits.material.uniforms.uCut.value = cutVis;
  cutBits.visible = cutVis > 0.01;
  return p;
}

/** Гало под курсором включается только рядом с локоном (|x|<2.0, |y|<5.6),
 *  иначе подсветка неожиданно вспыхивала бы над текстом в боковых колонках. */
function updateMouseGlow() {
  const inside = mTarget.x < 9000;
  const nearLock = Math.abs(mTarget.x) < 2.0 && Math.abs(mTarget.y) < 5.6;
  uniforms.uGlow.value = inside && nearLock ? 1 : 0;
}

let drawn = MAX_STRANDS;
// Потолок нитей для текущей ширины окна. Governor работает только вниз от
// него, поэтому на широком экране сцена получает больше нитей, а на узком —
// меньше, и при этом FPS-страховка сохраняется.
let strandCap = strandsForWidth(innerWidth);
const washLayers = () => [bubbles, water, foamRivulet];
// Слои, которым нужен gl_PointSize в CSS-пикселях при resize
const sizedLayers = () => [...washLayers(), steam, cutBits, sprayFast, sprayCloud];
function setStrands(n) {
  drawn = Math.min(Math.max(n, GOV_MIN), strandCap);
  geo.setDrawRange(0, drawn * VPL);
  uniforms.uCount.value = drawn;
  // Слои мытья масштабируются тем же governor: иначе на слабой машине они
  // просадят FPS, governor срежет нити — и подмена бросится в глаза.
  for (const pts of washLayers()) {
    const total = pts.geometry.attributes.aDrop.count;
    pts.geometry.setDrawRange(0, Math.ceil(total * (drawn / MAX_STRANDS)));
  }
  setStatus(`3D: ${drawn} нитей · ${(drawn * SEG * 2 / 1000).toFixed(1)}k треугольников`);
}

window.__pfpLock = {
  uniforms, renderer, geo,
  get strands() { return drawn; },
  get maxStrands() { return MAX_STRANDS; },
  get triangles() { return drawn * SEG * 2; },
  setStrands,
  get strandCap() { return strandCap; },
  // Слои частиц нужны для отладки этапа фиксации и финала из консоли/тестов.
  sprayFast, sprayCloud, glitter, camera,
  get spray() {
    return [sprayFast, sprayCloud].map((p) => ({
      visible: p.visible,
      lacquer: +p.material.uniforms.uLacquer.value.toFixed(3),
      nozzle: p.material.uniforms.uNozzle.value.toArray().map((v) => +v.toFixed(2)),
      dir: p.material.uniforms.uDir.value.toArray().map((v) => +v.toFixed(2)),
    }));
  },
};
window.__pfpStage = () => ({
  stage: stageKey, local: +stageLocal.toFixed(3), navReady,
  scroll: +uniforms.uScroll.value.toFixed(3), weave: +uniforms.uWeave.value.toFixed(3),
  strands: drawn, triangles: drawn * SEG * 2,
});

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
 */
function syncWidth() {
  const wantWorld = 2 * halfViewW * WIDTH_FRAC;
  uniforms.uWidthK.value = THREE.MathUtils.clamp(wantWorld / (2 * BUNDLE_R), 0.5, 2.6);
  const px = Math.round(innerWidth * WIDTH_FRAC);
  document.documentElement.style.setProperty('--center', `${px}px`);
}

function syncResolution() {
  const pr = renderer.getPixelRatio();
  uniforms.uRes.value.set(innerWidth * pr, innerHeight * pr);
  // gl_PointSize считается в CSS-пикселях
  for (const pts of sizedLayers()) pts.material.uniforms.uViewportH.value = innerHeight;
  syncWidth();
}
syncResolution();

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const off = localStorage.getItem('pfp-particles-off') === '1';

if (reduced || off) {
  uniforms.uIntro.value = 1;
  uniforms.uScroll.value = 0.30;
  uniforms.uWeave.value = 1;
  setStrands(strandCap);
  readStage();          // выставит uWash и видимость капель
  uniforms.uTime.value = 2.0;
  renderer.render(scene, camera);
  setStatus('Анимация выключена');
} else {
  // Governor: ровно одна нить за шаг (2.7/2.8), гистерезис, cooldown.
  const FPS_LOW = 24;
  const FPS_HIGH = 30;
  const COOLDOWN_MS = 2000;
  let frames = 0;
  let fpsAcc = 0;
  let lastChange = 0;
  let last = performance.now();
  const t0 = last;

  function governor(fps, now) {
    if (now - lastChange < COOLDOWN_MS) return;
    if (fps < FPS_LOW && drawn > GOV_MIN) {
      setStrands(drawn - 1);
      lastChange = now;
      console.info(`[lock] fps=${fps.toFixed(1)} → нитей ${drawn}`);
    } else if (fps > FPS_HIGH && drawn < strandCap) {
      setStrands(drawn + 1);
      lastChange = now;
      console.info(`[lock] fps=${fps.toFixed(1)} → нитей ${drawn}`);
    }
  }

  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    const t = (now - t0) / 1000;

    frames++;
    fpsAcc += dt;
    if (fpsAcc >= 1.5) {
      const fps = frames / fpsAcc;
      frames = 0;
      fpsAcc = 0;
      governor(fps, now);
    }

    mouse.x += (mTarget.x - mouse.x) * 0.09;
    mouse.y += (mTarget.y - mouse.y) * 0.09;
    uniforms.uTime.value = t;
    uniforms.uMouse.value.set(mouse.x, mouse.y);
    uniforms.uIntro.value = Math.min(t / 3.4, 1);
    readStage();
    updateMouseGlow();
    updateScissors(uniforms.uScroll.value, t);
    updateIron(uniforms.uScroll.value);
    updateFix(uniforms.uScroll.value);
    updateResult(uniforms.uScroll.value, t);
    const st = (t - successT0) / 2.5;
    uniforms.uSuccess.value = st >= 0 && st <= 1 ? Math.sin(st * Math.PI) : 0;
    renderer.render(scene, camera);
  }

  setStrands(strandCap);
  requestAnimationFrame(loop);
}

// Resize держим ВНЕ ветки reduced/off. Раньше он был внутри else, поэтому при
// статичном кадре (reduced-motion или выключенная анимация) ресайз не
// обрабатывался вовсе: камера сохраняла аспект на момент загрузки, и кадр
// растягивался. В статичном режиме обработчик безвреден — он только
// пересчитывает проекцию и размер вьюпорта.
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  halfViewW = halfViewH * camera.aspect;
  renderer.setSize(innerWidth, innerHeight);
  // Потолок нитей тоже зависит от ширины: сузили окно — получили меньше
  // нитей. Governor при этом сохраняет право срезать ещё сильнее.
  strandCap = strandsForWidth(innerWidth);
  if (drawn > strandCap) setStrands(strandCap);
  syncResolution();
  // В статичном режиме loop не идёт, поэтому кадр перерисовываем здесь.
  if (reduced || off) renderer.render(scene, camera);
}, { passive: true });

// Скролл только двигает сцену. Рендерить из хендлера не нужно: loop и так
// рисует каждый кадр, а лишний полный проход на каждое событие скролла
// (их десятки в секунду) — чистая потеря кадрового бюджета. Прежний
// комментарий про «governor, ушедший в фон» коду не соответствовал:
// requestAnimationFrame здесь никогда не отменяется.
addEventListener('scroll', () => {
  readStage();
  if (reduced || off) {
    uniforms.uMouse.value.set(mouse.x, mouse.y);
    renderer.render(scene, camera);
  }
}, { passive: true });

function setStatus(t) {
  const el = document.getElementById('particles-toggle');
  if (el) el.textContent = t;
}

// Кнопка «Анимация». Обработчик раньше жил в particles.js, но тот файл
// выходил на строке `if (!canvas) return;` — canvas #particles в шаблонах
// давно нет, поэтому до обработчика дело не доходило и кнопка была мёртвой.
// Теперь переключение живёт здесь, а lock.js же читает pfp-particles-off при
// старте, то есть состояние переживает перезагрузку.
(() => {
  const btn = document.getElementById('particles-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const nowOff = localStorage.getItem('pfp-particles-off') === '1';
    localStorage.setItem('pfp-particles-off', nowOff ? '0' : '1');
    // Полная перезагрузка — единственный честный способ переключить режим:
    // нужно пересобрать ветку reduced/off, слои частиц и governor, а не
    // гасить уже запущенный requestAnimationFrame наполовину.
    location.reload();
  });
})();
