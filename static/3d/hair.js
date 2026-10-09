// Перманентные волосы.
//
// Модель-соглашение: этот модуль ВСЕГДА рисует локон, висящий по центру
// страницы, и никогда не выключается по стадии. Стадии меняют только
// состояние (uniform'ы), а не факт существования. Этапы 2–6 не имеют права
// трогать геометрию здесь — только phases/* через uniforms.
//
// Инварианты, которые нельзя нарушать:
//  • Нити не пересекаются. Достигается конструктивно: плеи — непересекающиеся
//    радиальные полосы, внутри плеи у всех нитей одинаковая угловая скорость.
//    Вращение в пределах полосы сохраняет порядок, между полосами радиусы
//    разные. Любая «фаза» в clump/разбросе это ломает.
//  • Ширина нити ≈1–1.6 device px (PX_WIDTH=1.0 × thick × профиль 1.30→0.62,
//    пол 1.0): линия расширяется в clip-space, потому что gl.lineWidth
//    в WebGL зажат в 1 px. Плотный центр — это сотни перекрытий, не ширина.
//  • clump зависит ТОЛЬКО от t (одинаков для всех нитей) — иначе плодится
//    пересечение.
import * as THREE from 'three';
import { checkGlsl, scene } from './core.js';
import {
  MAX_STRANDS, SEG, PX_WIDTH, TOP, LEN, HERO_STRANDS, GOV_MIN, PLIES,
  PLY_R0, PLY_DR, PLY_THICK, qn, TL, g,
} from './config.js';

// Две вершины на сегмент → лента из 2 треугольников на сегмент
export const VPL = SEG * 6;
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

/** Покой нити (стадия 0): вертикаль с естественным изгибом, не палка.
 * Статичная волна зависит только от t/phase (не от времени) — порядок плей
 * не трогает, амплитуда 0.05 при зазоре полос 0.06... нет, при радиусах
 * 0.6+: смещение ничтожно против межполосного расстояния, пересечений нет. */
function restPos(R, phase, t, out) {
  const spread = 0.30 + R * 1.5;
  const a = phase * 6.28318530718;
  out[0] = Math.cos(a) * spread * 0.40 + Math.sin(t * 9.0 + a) * 0.05;
  out[1] = TOP - t * LEN;
  out[2] = Math.sin(a) * spread * 0.30 + Math.cos(t * 7.0 + a) * 0.04;
}

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

export const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
geo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 4));

// Общий объект uniform'ов. Частицы ЗАИМСТВУют отсюда uTime и uIronPos, а
// uniforms знают только свои значения — это единственное место, где живёт
// состояние волос.
export const uniforms = {
  uTime: { value: 0 },
  uMouse: { value: new THREE.Vector2(9999, 9999) },
  uScroll: { value: 0 },
  uWeave: { value: 0 },
  uCurl: { value: 1 },      // завитость/ветвление: начальные стадии
  uStraight: { value: 0 },  // мытьё — нити прямые
  uWrap: { value: 0 },      // обвивка прядь вокруг утюжка (этап 4)
  uCurlDone: { value: 0 },  // прядь осталась завитой после отпускания
  uGloss: { value: 0 },     // глянец от лака (этап 5)
  uGlue: { value: 0 },      // склейка прядей (этап 5)
  uPlyThick: { value: PLY_THICK },
  uWidthK: { value: 1 },    // ширина локона привязана к ширине окна
  // Этап 6. Свет здесь шейдерный: обычный THREE.SpotLight/PointLight в этой
  // сцене бесполезен — нити рисует кастомный ShaderMaterial, у него в
  // конвейере нет ни одного источника света Three.js.
  uGlint: { value: 0 },    // сила акцентного блика
  uGlintY: { value: 0 },   // положение полосы сканирования по высоте
  uGlitter: { value: 0 },  // интенсивность блесток
  uGrade: { value: new THREE.Vector3(1, 1, 1) },  // цветокоррекция сцены
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

  // Мокрый вид (этап 2, из look-wash.json через phase2).
  uWetDarken: { value: 0.35 }, // потемнение мокрых
  uWetGloss: { value: 0.8 },   // усиление узкого R-блика мокрых

  // WASH v2.1: вес мокрости и фронт воды. Пишет phases/phase2.js.
  uWet: { value: 0 },       // 0 сухое → 1 мокрое (TL.wet)
  uWetClump: { value: 0 },  // слипание мокрых (догоняет uWet)
  uWashFlow: { value: 0 },  // спуск фронта воды (TL.washFlow)
  // Пятна грязи: x=jit-цель, y=t на пряди, z=размер, w=смытость 0..1.
  // Заполняет phase2 каждый кадр (6 vec4 — дёшево). Жвачка DROPPED по ТЗ.
  uStains: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
  uStainCount: { value: 6 },

  // Этап 1 «до»: грязные/непослушные/отпадают. Пишет только phases/phase1.js.
  uDirt: { value: 0 },   // пыль и комки: вуаль + матовость
  uGum: { value: 0 },    // жвачка в волосах (розовый комок, t≈0.55)
  uGumX: { value: -0.55 }, // ось склейки: слева внутри массы…
  uGumZ: { value: 0.45 },  // …и к переднему плану (передняя поверхность ~1.0)
  uWild: { value: 0 },   // непослушное качание паттернами (окно 30–70%)
  uChaos: { value: 0 },  // рваный джит каждой нити (окно 17–37%)
  uShed: { value: 0 },   // отпадание прядей (45–100%)
};

const mat = new THREE.ShaderMaterial({
  uniforms,
  // Переход с blended transparency на alpha-test + depth write: 500
  // полупрозрачных нитей без сортировки складывались в перекрытиях и выбивали
  // центр в белый. Depth-test решает перекрытие, а стохастический alpha-dither
  // вместо жёсткого alphaTest смягчает края (приём UE5/Frostbite).
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
    uniform float uDirt, uGum, uWild, uShed, uChaos;
    uniform float uGumX, uGumZ;
    uniform float uGloss, uGlue, uPlyThick, uGlint, uGlintY, uGlitter, uWidthK;
    uniform float uWet, uWetClump;
    uniform vec4 uStains[6];
    uniform float uStainCount;
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
    varying float vTip;
    varying float vThick;
    varying float vClump;
    varying float vGumC;
    varying float vGumE;
    varying float vWet;
    varying float vStain;

    const float PI2 = 6.28318530718;
    const float PI = 3.14159265359;
    const float TOP = 7.6;
    // Нити длиннее видимой области: корни уходят за верхний край кадра,
    // кончики — за нижний, поэтому не видно границ рендера.
    const float LEN = 17.5;

    // Линия среза. ЭТА ЖЕ формула продублирована в JS (cutLine в hair.js) — по
    // ней едут ножницы, поэтому разрез идёт ровно под лезвиями.
    // Синус зависит ТОЛЬКО от x (не от cutT): иначе при спуске линии пряди
    // попеременно оказывались то под линией, то над ней — мерцание.
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

      // Жвачка: якорь слева внутри массы (фаза ~0.5). Маски считаются ЗДЕСЬ,
      // потому что нужны дважды: склейке (ниже) и комку (у ширины).
      float gS = 1.0 - smoothstep(0.03, 0.09, abs(phase - 0.5));
      float gT = 1.0 - smoothstep(0.02, 0.035, abs(t - 0.55));
      float gAmt = gS * gT * uGum;

      vec3 rest = position;
      vec3 dRest = vec3(0.0, -LEN, 0.0);

      // Спираль. Радиус приходит из aSeed уже абсолютным (полоса плея),
      // поэтому между плеями расстояние постоянно и пересечение невозможно.
      // У каждого плея своя скорость — отсюда переплетение.
      float plyN = clamp((rad - uPlyR0) / uPlyDr, 0.0, 1.0);

      // Слипание (WASH v2.1): общий инлайн для лака и мокрости. Мокрые слабее
      // лака (0.48 vs 0.82). Сжимается ТОЛЬКО отклонение внутри слота —
      // положение полос плей не трогаем (инвариант непересечения).
      float clumpK = max(uGlue * 0.82, uWetClump * 0.48);
      if (clumpK > 0.001) {
        float base = uPlyR0 + plyN * uPlyDr;
        float slotDev = (rad - base) / max(uPlyThick, 1e-4);   // -0.5..0.5
        rad = base + slotDev * uPlyThick * (1.0 - clumpK);
        plyN = clamp((rad - uPlyR0) / uPlyDr, 0.0, 1.0);
      }
      // Ширина локона = WIDTH_FRAC ширины окна. Масштабируем ТОЛЬКО радиус:
      // высота (TOP/LEN) остаётся в world-координатах, поэтому вертикальный
      // масштаб кадра не меняется. plyN уже посчитан по немасштабированному
      // rad, а масштаб равномерный — инвариант «нити не пересекаются» цел.
      rad *= uWidthK;
      // Слабая крутка (этап 1): ~1/3 витка на всю длину вместо полных 1–1.5.
      // Полная спираль давала «канат», который визуально выглядел слабо.
      // Нежное переплетение + худоба braidK читаются как локон, а не верёвка.
      float turns = (0.95 + plyN * 0.55) * (1.0 - uStraight) * (1.0 - 0.65 * uWeave);
      float th = phase * PI2 + t * turns * PI2 + uTime * 0.07;
      // clump зависит ТОЛЬКО от t — одинаков для всех нитей, поэтому
      // радиальный порядок сохраняется. Мокрые тяжелее: волна прибита.
      float clump = 1.0 + 0.16 * sin(t * 2.7) * (1.0 - uStraight * 0.7) * (1.0 - uWet * 0.4);
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

      // Худое плетение (этап 1): навивка лишь на ~10% шире гладких волос.
      // Было до ~2× (полуширина спирали 1.5 против 0.7 у покоя) — слишком
      // объёмно. Масштаб равномерный по x/z, тот же для касательной —
      // инвариант непересечения цел. При uWeave=0 множитель 1: эталон
      // стадии 0 не тронут.
      float braidK = mix(1.0, 0.62, uWeave);
      curl.x *= braidK;
      curl.z *= braidK;
      dCurl.x *= braidK;
      dCurl.z *= braidK;

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

      // Пушок (frizz): микро-рябь на ВСЕХ нитях, а не только 13% fly.
      // Амплитуда 0.012 — впятеро меньше зазора полос 0.06, порядок цел.
      // Частота высокая (47/39), фаза своя от jit — это смещение, не clump.
      p.x += sin(t * 47.0 + jit * 6.2831) * 0.012;
      p.z += cos(t * 39.0 + jit * 6.2831) * 0.010;

      // Живое движение гейсится отдельным окном: пока идёт плетение и первые
      // стадии. Границы = TL.idle.
      float idle = 1.0 - smoothstep(${g(TL.idle[0])}, ${g(TL.idle[1])}, uScroll);
      float w1 = t * 5.5 * wf - uTime * 1.15 * wf + phase * PI2;
      float w2 = t * 11.0 * wf + uTime * 0.72 + jit * PI2;
      float amp = (0.075 + fly * 0.10) * idle;
      p.x += (sin(w1) * 0.7 + sin(w2) * 0.3) * amp;
      p.z += (cos(w2) * 0.6 + sin(w1 * 0.5) * 0.4) * amp * 0.8;

      // Непослушность (этап 1, окно 30–70% через uWild): крупные направленные
      // волны — половины пучка (bdir) в противофазе, у каждой плеи своя фаза.
      // Смещение поперечное, зависит только от t и плеи — радиальный порядок
      // полос цел, визуально — «паттерны в разные стороны».
      float wildPh = t * 3.0 - uTime * 0.9 + plyN * 3.0;
      p.x += sin(wildPh) * bdir * 0.18 * uWild;
      p.z += cos(wildPh * 0.8 + 1.7) * 0.12 * uWild;

      // Хаос (этап 1, окно 17–37% через uChaos): высокочастотный рваный джит,
      // у каждой нити своё направление из хэша — в отличие от wild-паттернов,
      // где половины пучка идут строем. Движение не останавливается никогда:
      // хаос подхватывает раньше wild и пересекается с ним.
      float chH1 = fract(jit * 57.31) - 0.5;
      float chH2 = fract(jit * 91.17) - 0.5;
      float chPh = t * 23.0 + uTime * 2.6 + jit * 6.2831;
      p.x += sin(chPh) * chH1 * 0.28 * uChaos;
      p.z += cos(chPh * 1.3) * chH2 * 0.20 * uChaos;
      p.y += sin(chPh * 0.7 + chH1 * 9.0) * 0.06 * uChaos;

      // Мытьё: нити раздвигаются и становятся прямыми (uStraight).
      // Границы = TL.washHair (НЕ PHASE.wash — контентная сетка другая).
      float wash = smoothstep(${g(TL.washHair[0])}, ${g(TL.washHair[1])}, uScroll)
        * (1.0 - smoothstep(${g(TL.washHair[2])}, ${g(TL.washHair[3])}, uScroll));
      p.x += sin(phase * PI2) * wash * 0.26;

      // Срез ножницами: линия среза ползёт вниз по синусоиде, всё что под
      // ней — отрезано и падает. Границы = TL.cut.
      float cutT = clamp((uScroll - ${g(TL.cut[0])}) / ${g(TL.cut[1] - TL.cut[0])}, 0.0, 1.0);
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

      // Укладка/завивка. Баланс между «почти не видно» (0.08+0.30) и «углы у
      // линий, волна пересекает сама себя» (0.16+0.66, cf 1.75). Амплитуда
      // держится ниже радиуса пучка (~0.6), иначе виток выходит за bundle.
      float wave = smoothstep(${g(TL.wave[0])}, ${g(TL.wave[1])}, uScroll);
      float curlAmp = (0.11 + 0.40 * plyN) * wave;
      float cf = 1.35;
      p.x += sin(p.y * cf + uTime * 1.10 + phase * PI2) * curlAmp;
      p.z += cos(p.y * cf * 0.75 + uTime * 0.85 + phase * PI2) * curlAmp * 0.40;

      // --- Утюжок (этап 4) ------------------------------------------------
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

      // Лак. Границы = TL.lacq, плюс глянец от фиксации (TL.fixGloss) —
      // он держится до конца страницы.
      float lacq = max(smoothstep(${g(TL.lacq[0])}, ${g(TL.lacq[1])}, uScroll), uGloss);
      vWet = wash;

      // Салют
      vec3 dir = p - vec3(0.0, 0.4, -1.0);
      p += (dir / max(length(dir), 0.001)) * uSuccess * (2.2 + jit * 2.0);

      // Отпадание (этап 1, 45–100% через uShed): до 10% нитей с малым хэшем
      // рвутся КУСКАМИ разной длины — точка отрыва своя (от коротких
      // кончиков до длинных прядей). Кусок летит вниз с ускорением и вбок,
      // растворяется в полёте. Верх пряди остаётся на месте.
      float shedH = fract(jit * 13.73);
      float sp = clamp((uShed * 0.10 - shedH) / 0.02, 0.0, 1.0);
      float breakT = 0.30 + fract(shedH * 7.17) * 0.62;
      float piece = smoothstep(breakT - 0.02, breakT + 0.02, t);
      float pieceLen = 1.0 - breakT;
      p.y -= piece * sp * sp * (1.5 + pieceLen * 4.0);
      float sideDir = fract(shedH * 3.3) < 0.5 ? -1.0 : 1.0;
      p.x += piece * sp * sideDir * (0.3 + fract(shedH * 5.9) * 1.1);
      p.z += piece * sp * cos(shedH * 44.0) * 0.4;

      // Склейка жвачкой: пряди МЯГКО тянутся к вертикальной оси комка.
      // Сила всего 0.30: жёсткие 0.85 заламывали линии углами, а реальные
      // волосы не ломаются. Связь читается пятном частиц поверх (gum.js),
      // здесь — только лёгкое сгущение. Касательную не правим: зона
      // матовая/розовая, блик там всё равно убит или перекрашен.
      p.x = mix(p.x, uGumX, gAmt * 0.30);
      p.z = mix(p.z, uGumZ, gAmt * 0.30);

      // ---- Видимость нити ------------------------------------------------
      // Вход: нити ПАДАЮТ сверху — вся прядь смещена вверх и оседает.
      // drop² — ease-out: быстро в начале, мягкая посадка в конце.
      // Шторка grow стартует с TOP+9, чтобы падающие корни (7.6+5) были
      // скрыты: при входе не нарисовано НИЧЕГО, всё падает разом.
      float dropK = 1.0 - smoothstep(0.0, 1.0, uIntro);
      p.y += dropK * dropK * 5.0;
      // Стадия 0: шторка уходит НИЖЕ всех кончиков, поэтому после интро
      // ничего не отсекается — иначе была видна нижняя граница.
      float grow = mix(TOP + 9.0, -13.0, smoothstep(0.0, 0.92, uIntro));
      float reveal = smoothstep(grow - 2.2, grow + 0.6, p.y);
      // Гейт appear УБРАН: он показывал только нити с jit<0.16 (~16%), и на
      // старте было ≈100 видимых из 645 — выглядело дёшево. Теперь видны все
      // нарисованные, а вход даёт reveal (падение сверху). Вернуть можно одной
      // строкой, если понадобится «одиночные нити» вместо «стена волос».

      // Разная длина: короткие нити заканчиваются выше — неровный низ, как
      // в референсах. Длинные уходят за кадр и их кончиков не видно.
      float lenMask = 1.0 - smoothstep(lenF - 0.16, lenF, t);
      // Кончик сходит на нет: 1 в теле → 0 на самом конце. Во fragment через
      // vAlpha даст разреженный кончик вместо жёсткого среза lenMask.
      vTip = 1.0 - smoothstep(lenF - 0.10, lenF, t);

      // Финал: нити расходятся до HERO_STRANDS геройских. Порядок убывания —
      // низко-дискриминантный, поэтому оставшиеся распределены по объёму.
      float heroCut = uHero / max(uCount, 1.0);
      float isHero = smoothstep(heroCut + 0.04, heroCut - 0.02, jit);
      // Финальное прореживание. Границы = TL.finale (внутри этапа TL.result).
      float finale = smoothstep(${g(TL.finale[0])}, ${g(TL.finale[1])}, uScroll);
      float keep = mix(1.0, isHero, finale);

      vAlpha = reveal * keep * lenMask * (1.0 - fall * 0.92) * (1.0 - piece * sp);
      // Кончик растворяется: стохастический discard поредеет к концу нити.
      vAlpha *= 0.30 + 0.70 * vTip;
      // Входной гейт: при uIntro=0 строго ноль — страховка поверх шторки.
      vAlpha *= smoothstep(0.0, 0.05, uIntro);
      // Толщина/яркость нити (aSeed.w 0.75..1.25) — во fragment даст
      // по-нитевую вариацию тона, иначе центр выглядит пластиковой шторкой.
      vThick = thick;
      vT = t;
      vSeed = jit;
      vRad = plyN;
      vEdge = aSide;
      // Высота в объектных координатах: по ней едет блик этапа 6.
      vY = p.y;

      // ---- Расширение линии в clip-space (2–3 px) -------------------------
      // Толщина сужается к кончику (мейнстрим волос — не труба), но не ниже
      // ~1px: субпиксельные нити превращаются в dither-крап.
      // Комки грязи/пыли (этап 1): ~7% сегментов утолщены. Хэш от
      // (нить, кусок) — комки сидят на фиксированных местах пряди.
      float clumpH = fract(sin(jit * 91.7 + floor(t * 14.0) * 17.3) * 43758.5453);
      vClump = step(0.916, clumpH) * uDirt;
      // Жвачка (этап 1): размазанное пятно — налепили и растянули.
      // gS/gT/gAmt посчитаны в начале main (нужны были склейке выше).
      // Края грубые засохшие (рваный хэш), центр тянется тонко и местами
      // полупрозрачен (дыры). Цвет и глянец — во fragment.
      float gRagh = fract(sin(floor(jit * 90.0) * 12.9 + floor(t * 160.0) * 78.2) * 43758.5453);
      float gEdge = gAmt * smoothstep(0.35, 0.75, gRagh + gS * 0.25);
      float gCore = gAmt * (1.0 - gEdge);
      float gHole = gCore * step(0.72, fract(sin(jit * 371.0 + floor(t * 220.0) * 11.0) * 24634.6));
      vGumC = gCore;
      vGumE = gEdge;
      // Ширина: корка толстая, тянущийся центр тоньше.
      float gumW = 1.0 + gEdge * 2.4 + gCore * 0.6;
      // Пятна грязи (WASH v2.1, §7.5.1): вес гаусса в (jit, t)-пространстве.
      // Компрессия клампа радиальная, не вдоль t — пятна не дрейфуют.
      // Утолщение скромное (×2): грязь, не жвачка.
      float stain = 0.0;
      for (int i = 0; i < 6; i++) {
        if (float(i) >= uStainCount) break;
        vec4 sU = uStains[i];
        float dJ = (jit - sU.x) * 55.0;
        float dT = (t - sU.y) * 22.0;
        stain = max(stain, exp(-dJ * dJ) * exp(-dT * dT) * sU.z * (1.0 - sU.w));
      }
      vStain = stain;
      float wpx = max(uPx * thick * mix(1.30, 0.62, smoothstep(0.0, 0.85, t)) * (1.0 + fly * 0.4) * (1.0 + vClump * 1.3) * gumW * (1.0 + stain * 2.0), 1.0);
      // Дыры в тянущемся центре: местами волос просвечивает сквозь жвачку.
      vAlpha *= 1.0 - gHole * 0.85;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vec3 tanView = normalize(mat3(modelViewMatrix) * tang);
      vTan = tanView;
      vView = mv.xyz;

      // Затенение по глубине вместо сортировки: z<0 — ближе к зрителю.
      float zNorm = clamp((-mv.z - 9.5) / 3.2, 0.0, 1.0);
      vShade = zNorm;

      // Спекляр переносим во fragment. WASH v2.1: старое прибивание блика
      // мокростью (1 - wet*0.55) УДАЛЕНО — мокрые ярче, фрагмент (§7.2) теперь
      // владеет поведением через gainW.
      vSpec = 1.0 + lacq * 0.9 + wave * 0.35 + uSuccess * 0.8;
      // Грязные волосы матовые: общий блик прибивается почти вдвое.
      vSpec *= 1.0 - uDirt * 0.45;

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
    uniform float uGlow, uPx, uTime;
    uniform float uDirt, uGum;
    uniform float uWetDarken, uWetGloss;
    uniform float uShiftR, uShiftTRT, uExpR, uExpTRT, uGainR, uGainTRT;
    uniform float uMelanin, uRedness, uMelJitter;
    uniform float uScatter, uDensity, uRootDark, uRootLen, uAmb;
    // Этап 6: акцентный блик едет по vY. Объявлено здесь, во fragment: в vertex
    // эти uniform-ы не нужны, а без декларации GLSL их не находит и шейдер не
    // собирается.
    uniform float uGlint, uGlintY;
    // Цветокоррекция сцены: три множителя, собираются в JS по стадиям.
    uniform vec3 uGrade;

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
    varying float vTip;
    varying float vThick;
    varying float vClump;
    varying float vGumC;
    varying float vGumE;
    varying float vWet;
    varying float vStain;

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
      // Абсолютный порог: хэш постоянен на всю нить, поэтому нити с
      // hStrand≈0 проступают призраками на всю длину даже при vAlpha≈0 —
      // именно их видно на входе. Отсекаем до стохастического теста.
      if (vAlpha < 0.004) discard;
      if (vAlpha < hStrand) discard;

      // ---- Цвет из меланина ----------------------------------------------
      float melJit = (vSeed * 2.0 - 1.0) * uMelJitter;
      // У корня меланина больше — тёмный корень, как в референсах.
      float rootRamp = 1.0 - smoothstep(0.0, uRootLen, vT);
      float mel = clamp(uMelanin + melJit + uRootDark * rootRamp, 0.0, 1.0);
      // Выцветание к кончику (солнце): пигмента к концу на ~12% меньше.
      // Физично осветляет кончики через тот же Beer–Lambert ниже.
      mel *= 1.0 - 0.12 * vT;
      vec3 sigmaA = EUMELANIN * (mel * (1.0 - uRedness))
                  + PHEOMELANIN * (mel * uRedness);
      vec3 base = exp(-sigmaA * 5.0);
      // По-прядная hue-вариация: соседние пряди чуть разного оттенка, иначе
      // монотонность цвета. vSeed — jit нити (per-strand), ±3% — тон, не шум.
      // tintTRT/tintTT ниже наследуют её автоматически (считаются от base).
      vec3 hueJ = vec3(fract(vSeed * 7.31) - 0.5,
                       fract(vSeed * 3.77) - 0.5,
                       fract(vSeed * 5.13) - 0.5);
      base *= 1.0 + hueJ * 0.06;
      // Пыльная вуаль (этап 1): общий тон к серо-коричневому, убивает глубину
      // цвета. Комки (vClump) красятся отдельно ниже, здесь только налёт.
      base = mix(base, vec3(0.42, 0.36, 0.29), uDirt * 0.42);
      // Мокрые темнее (как на фото «душ»).
      base *= 1.0 - vWet * uWetDarken;

      // ---- Нормаль цилиндрической нити -----------------------------------
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

      // ---- Marschner: два лепестка ---------------------------------------
      vec3 TR  = shiftTangent(T, N, uShiftR);
      vec3 TRT = shiftTangent(T, N, uShiftTRT);
      float lobeR  = strandSpecular(TR,  V, uLightA, uExpR)   * uGainR;
      float lobeTRT = strandSpecular(TRT, V, uLightB, uExpTRT) * uGainTRT;
      lobeR  *= vSpec;
      lobeTRT *= vSpec;
      // TRT окрашен абсорбцией волоса — это и есть золотой «второй блик».
      // Частичная десатурация, иначе чистый блонд уходит в металл.
      vec3 tintTRT = mix(base, vec3(dot(base, vec3(0.3, 0.6, 0.1))), 0.35);
      vec3 specR  = vec3(1.0, 0.98, 0.94) * lobeR * (1.0 + vWet * uWetGloss);
      vec3 specTRT = tintTRT * lobeTRT;

      // ---- Rim + TT: контровой свет --------------------------------------
      // Волосы узнаются по светящемуся контуру: источник сзади-сверху.
      // Камера не вращается — направление фиксировано константой.
      // TT — просвечивание (средний лепесток Marschner, exp ~8): свет проходит
      // СКВОЗЬ нить, поэтому красит в осветлённый base и зависит от того,
      // смотрит ли зритель на свет (forward scattering через -V·L).
      vec3 Lrim = normalize(vec3(0.10, 0.60, -1.00));
      float fwd = clamp(dot(-V, Lrim) * 0.5 + 0.5, 0.0, 1.0);
      float lobeTT = strandSpecular(T, V, Lrim, 8.0) * (0.25 + 0.75 * fwd * fwd);
      vec3 tintTT = mix(base, vec3(1.0), 0.30);
      vec3 specTT = tintTT * lobeTT * 0.35 * vSpec;

      // ---- Kajiya-Kay diffuse + fake multiple scattering ------------------
      float LdotT = dot(T, uLightA);
      float sinTL = sqrt(max(1.0 - LdotT * LdotT, 0.0));
      // Мягкая граница тени: lerp вместо жёсткого N·L (GDC 2004).
      float wrap = sinTL * 0.5 + 0.5;
      float diffuse = mix(0.30, 1.0, wrap);
      // Переизлучение соседних нитей подсвечивает теневую сторону.
      float multi = (1.0 - wrap) * uScatter;
      float ambient = uAmb;

      // ---- Плотность bundle: Beer–Lambert + глубина ----------------------
      // Внутренние и дальние нити получают больше рассеяния → темнее и теплее.
      float depth = vShade;                       // 0 = далеко, 1 = близко
      float density = (1.0 - depth) * 0.75 + (1.0 - vRad) * 0.45;
      vec3 atten = exp(-sigmaA * density * uDensity * 2.2);
      float depthDim = mix(0.34, 1.0, depth * depth);

      vec3 col = base * atten * (diffuse + multi + ambient) * depthDim;
      // Комки и корка жвачки матовые: зеркальный лепесток на них не играет.
      col += (specR + specTRT + specTT) * (1.0 - vClump) * (1.0 - vGumE * 0.9);
      // Комки грязи: тёмные, тон зависит от нити (не плоская заливка).
      col = mix(col, vec3(0.16, 0.13, 0.10) * (0.7 + 0.3 * vSeed), vClump * 0.85);
      // Жвачка: засохшая корка по краям (тёмная, матовая) и тянущийся
      // глянцевый центр. Блик на корке убит, в центре — розовый глянец.
      col = mix(col, vec3(0.42, 0.27, 0.30), vGumE * 0.9);
      col = mix(col, vec3(0.93, 0.42, 0.60) * (0.65 + 0.35 * vSpec), vGumC);
      col += vec3(1.0, 0.85, 0.92) * vGumC * 0.30 * vSpec;

      // Контактное затенение у корня: первые 12% длины в тени скальпа.
      col *= mix(0.45, 1.0, smoothstep(0.0, 0.12, vT));
      // Сухие светлые кончики: лёгкое тёплое осветление второй половины.
      col = mix(col, col * vec3(1.08, 1.02, 0.92) + vec3(0.030, 0.020, 0.010),
                smoothstep(0.55, 1.0, vT) * 0.50);
      // По-нитевая вариация: толстые нити темнее и теплее, тонкие — светлее.
      // Диапазон ±12% — достаточно, чтобы разбить «шторку», но не шум.
      float thickN = clamp((vThick - 0.75) / 0.5, 0.0, 1.0);
      col *= 1.06 - 0.12 * thickN;
      col *= vec3(1.0, 0.99 + 0.02 * thickN, 0.97 + 0.03 * (1.0 - thickN));

      // Область яркости под курсором — считается per-fragment, поэтому
      // светится только там, где реально лежат нити.
      float gd = length(vView.xy - uMouse);
      col += vec3(1.0, 0.87, 0.62) * exp(-gd * gd * 0.5) * uGlow * 0.9;

      // ---- Этап 6: акцентный блик, едущий сверху вниз --------------------
      // Узкая полоса по высоте. Усиливаем лепесток R (белый, exp 150) — он
      // отвечает за чёткий продольный блик на изгибах, поэтому полоса
      // «подчёркивает» текстуру, а не заливает пучок.
      float gband = exp(-pow((vY - uGlintY) * 0.62, 2.0));
      // Мелкая зернистость по seed, иначе полоса читается как ровная заливка.
      gband *= 0.75 + 0.45 * sin(vSeed * 61.0 + vT * 5.0);
      col += vec3(1.0, 0.95, 0.86) * gband * uGlint * (0.35 + vSpec * 0.85);

      // Бегущий блик: медленная светлая полоса сверху вниз (период ~36с) —
      // живое отражение, видно и в покое без скролла. В отличие от uGlint
      // (этап 6, едет от скролла) этот идёт от времени и работает всегда.
      float travPh = fract(uTime * 0.028);
      float travY = mix(8.0, -11.0, travPh);
      float trav = exp(-pow((vY - travY) * 0.55, 2.0));
      col += vec3(1.0, 0.96, 0.88) * trav * 0.10 * (0.35 + vSpec * 0.5);

      // Цветокоррекция — последняя операция, после блеска и гало, иначе
      // посчитается дважды на уже окрашенном сигнале.
      col *= uGrade;

      gl_FragColor = vec4(col, 1.0);
    }`,
});

export const lock = new THREE.Mesh(geo, mat);
checkGlsl('локон vertex', mat.vertexShader);
checkGlsl('локон fragment', mat.fragmentShader);
lock.frustumCulled = false;
scene.add(lock);

/**
 * Линия среза — зеркало GLSL-функции cutLine() из vertex shader.
 * Дублируется специально: GLSL нельзя вызвать из JS, поэтому важно, чтобы
 * формулы стояли рядом и совпадали. Проверяется глазом по синхронности
 * ножниц и разреза. При правке одной — править обе.
 */
export const cutLine = (x, cutT) => TOP - 1.6 - cutT * 11.0 + Math.sin(x * 2.3) * 0.55;
