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
//  • Ширина нити 2–3 px независимо от глубины: линия расширяется в clip-space,
//    потому что gl.lineWidth в WebGL зажат в 1 px.
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

/** Покой нити (стадия 0): тонкая вертикаль с разбросом по радиусу. */
function restPos(R, phase, t, out) {
  const spread = 0.30 + R * 1.5;
  out[0] = Math.cos(phase * 6.28318530718) * spread * 0.40;
  out[1] = TOP - t * LEN;
  out[2] = Math.sin(phase * 6.28318530718) * spread * 0.30;
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

      vec3 rest = position;
      vec3 dRest = vec3(0.0, -LEN, 0.0);

      // Спираль. Радиус приходит из aSeed уже абсолютным (полоса плея),
      // поэтому между плеями расстояние постоянно и пересечение невозможно.
      // У каждого плея своя скорость — отсюда переплетение.
      float plyN = clamp((rad - uPlyR0) / uPlyDr, 0.0, 1.0);

      // Склейка после лака (этап 5): отклонение пряди внутри плея сокращается —
      // пряди слипаются, пучок становится плотнее.
      // ВАЖНО: положение полос плей не трогаем. Если стягивать их к центру,
      // пучок схлопывается вдвое и волосы «уменьшаются».
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

      // Живое движение гейсится отдельным окном: пока идёт плетение и первые
      // стадии. Границы = TL.idle.
      float idle = 1.0 - smoothstep(${g(TL.idle[0])}, ${g(TL.idle[1])}, uScroll);
      float w1 = t * 5.5 * wf - uTime * 1.15 * wf + phase * PI2;
      float w2 = t * 11.0 * wf + uTime * 0.72 + jit * PI2;
      float amp = (0.075 + fly * 0.10) * idle;
      p.x += (sin(w1) * 0.7 + sin(w2) * 0.3) * amp;
      p.z += (cos(w2) * 0.6 + sin(w1 * 0.5) * 0.4) * amp * 0.8;

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
      float wet = wash;

      // Салют
      vec3 dir = p - vec3(0.0, 0.4, -1.0);
      p += (dir / max(length(dir), 0.001)) * uSuccess * (2.2 + jit * 2.0);

      // ---- Видимость нити ------------------------------------------------
      // Стадия 0: нити падают сверху. grow уходит НИЖЕ всех кончиков, поэтому
      // после интро ничего не отсекается — иначе была видна нижняя граница.
      float grow = mix(TOP + 3.0, -13.0, smoothstep(0.0, 0.92, uIntro));
      float reveal = smoothstep(grow - 2.2, grow + 0.6, p.y);
      // Гейт appear УБРАН: он показывал только нити с jit<0.16 (~16%), и на
      // старте было ≈100 видимых из 645 — выглядело дёшево. Теперь видны все
      // нарисованные, а вход даёт reveal (падение сверху). Вернуть можно одной
      // строкой, если понадобится «одиночные нити» вместо «стена волос».

      // Разная длина: короткие нити заканчиваются выше — неровный низ, как
      // в референсах. Длинные уходят за кадр и их кончиков не видно.
      float lenMask = 1.0 - smoothstep(lenF - 0.16, lenF, t);

      // Финал: нити расходятся до HERO_STRANDS геройских. Порядок убывания —
      // низко-дискриминантный, поэтому оставшиеся распределены по объёму.
      float heroCut = uHero / max(uCount, 1.0);
      float isHero = smoothstep(heroCut + 0.04, heroCut - 0.02, jit);
      // Финальное прореживание. Границы = TL.finale (внутри этапа TL.result).
      float finale = smoothstep(${g(TL.finale[0])}, ${g(TL.finale[1])}, uScroll);
      float keep = mix(1.0, isHero, finale);

      vAlpha = reveal * keep * lenMask * (1.0 - fall * 0.92);
      vT = t;
      vSeed = jit;
      vRad = plyN;
      vEdge = aSide;
      // Высота в объектных координатах: по ней едет блик этапа 6.
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

      // ---- Цвет из меланина ----------------------------------------------
      float melJit = (vSeed * 2.0 - 1.0) * uMelJitter;
      // У корня меланина больше — тёмный кор��нь, как в референсах.
      float rootRamp = 1.0 - smoothstep(0.0, uRootLen, vT);
      float mel = clamp(uMelanin + melJit + uRootDark * rootRamp, 0.0, 1.0);
      vec3 sigmaA = EUMELANIN * (mel * (1.0 - uRedness))
                  + PHEOMELANIN * (mel * uRedness);
      vec3 base = exp(-sigmaA * 5.0);

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
      vec3 specR  = vec3(1.0, 0.98, 0.94) * lobeR;
      vec3 specTRT = tintTRT * lobeTRT;

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
      col += specR + specTRT;

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
