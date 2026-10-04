// Локон PFP: GPU-облако точек (вуаль -> локон -> срез -> волна).
// CPU за кадр: только uniform'ы (uTime/uMouse/uScroll/uSuccess). Вся физика — GLSL.
// Адаптация: старт по железу (мобила 15k / десктоп 60k), drawRange-деградация,
// cap 30->24->18, kill <20. Respect prefers-reduced-motion + кнопка отключения.
import * as THREE from 'three';

const mount = document.getElementById('hero3d');
if (mount) init();

function init() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const off = localStorage.getItem('pfp-particles-off') === '1';
  const isMobile = matchMedia('(max-width:700px)').matches;
  // ?pfp_points=N — ручной лёгкий режим (2k..60k), удобно и для отладки стадий
  const qp = new URLSearchParams(location.search).get('pfp_points');
  const COUNT = qp ? Math.min(Math.max(parseInt(qp, 10) || 15000, 2000), 60000)
    : (isMobile ? 15000 : 60000);

  const renderer = new THREE.WebGLRenderer({ antialias: !isMobile, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 60);
  camera.position.set(0, 0, 11);
  const halfH = Math.tan(camera.fov * 0.5 * Math.PI / 180) * camera.position.z;
  const halfW = halfH * camera.aspect;

  // --- Формы: вуаль (диффузное облако) + локон (сэмплы прядей-кривых) ---
  const veil = new Float32Array(COUNT * 3);
  const lock = new Float32Array(COUNT * 3);
  const seed = new Float32Array(COUNT * 4);
  // Параметры геометрии локона: 72/32 выраженные пряди, филлотаксис 137.5°
  const STRANDS = isMobile ? 32 : 72;
  const pPerStrand = Math.ceil(COUNT / STRANDS); // Точек на одну прядь
  for (let i = 0; i < COUNT; i++) {
    // 1. Вуаль-стена на всю ширину (стадия 1: hero)
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    const r = 0.55 + 0.45 * Math.cbrt(Math.random());
    veil[i * 3 + 0] = r * Math.sin(ph) * Math.cos(th) * 7.5;
    veil[i * 3 + 1] = r * Math.cos(ph) * 5.6;
    veil[i * 3 + 2] = -r * Math.abs(Math.sin(ph)) * 5 - 1;
    // 2. Локон: структурированная голливудская волна (t: 0 корень -> 1 кончик)
    const strandIdx = i % STRANDS;
    const t = Math.floor(i / STRANDS) / pPerStrand;
    // Корни по золотому сечению: плотный центр, пушистые края
    const phiAngle = strandIdx * 2.39996; // 137.5° в радианах
    const rootR = 0.4 + Math.sqrt(strandIdx / STRANDS) * 0.75;
    // Ось локона: сужение книзу; спираль t*4.5 оборотов по длине
    const taper = 1.0 - t * 0.4;
    const spiralRadius = rootR * taper;
    const angle = phiAngle + t * 4.5;
    // Микро-текстура против слипания в трубы
    const microStrandShift = Math.sin(t * 30.0 + strandIdx * 12.0) * 0.04;
    lock[i * 3 + 0] = Math.cos(angle) * spiralRadius + microStrandShift;
    lock[i * 3 + 1] = 4.0 - t * 8.0; // +4.0..-4.0 под camera.z = 11
    lock[i * 3 + 2] = Math.sin(angle) * spiralRadius * 0.85; // приплюснут по Z
    // 3. Шейдерные данные: фаза по пряди (когерентное дыхание), размер к корням
    seed[i * 4 + 0] = strandIdx * 0.15 + t * 4.0;
    seed[i * 4 + 1] = 0.4 + (1.0 - t * 0.5) * Math.random() * 1.2;
    seed[i * 4 + 2] = (strandIdx / STRANDS) * 0.4 + Math.random() * 0.6;
    seed[i * 4 + 3] = 1.0 + Math.random() * 1.5;
  }
  const geo = new THREE.BufferGeometry();
  // position обязателен: Three считает drawCount по нему. Алиас на veil — без лишней памяти.
  geo.setAttribute('position', new THREE.BufferAttribute(veil, 3));
  geo.setAttribute('aVeil', new THREE.BufferAttribute(veil, 3));
  geo.setAttribute('aLock', new THREE.BufferAttribute(lock, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));

  const uniforms = {
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2(999, 999) },
    uScroll: { value: 0 },
    uIntro: { value: 0 },
    uSuccess: { value: 0 },
    uPixelRatio: { value: renderer.getPixelRatio() },
    uTintA: { value: new THREE.Color('#e8b34b') },
    uTintB: { value: new THREE.Color('#f5f1e8') },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 aVeil; attribute vec3 aLock; attribute vec4 aSeed;
      uniform float uTime, uScroll, uIntro, uSuccess, uPixelRatio;
      uniform vec2 uMouse;
      varying float vAlpha; varying float vTint; varying float vGloss;
      void main() {
        // Стадии по секциям: 0-0.08 стена, 0.08-0.18 сборка (Почему),
        // 0.15-0.30 мытьё (Услуги), 0.30-0.48 срез (Команда), 0.55-0.75 волна
        float morph = smoothstep(0.08, 0.18, uScroll);
        vec3 base = mix(aVeil, aLock, morph);
        // Интро: стена волос сверху -> маленькая прядь по центру -> вуаль. Медленно.
        float descend = smoothstep(0.0, 0.7, uIntro);
        vec3 wall = vec3(base.x * 1.8, 9.0 + fract(aSeed.x * 7.31) * 3.0, base.z - 1.5);
        vec3 smallLock = aLock * 0.45;
        float bloom = smoothstep(0.55, 1.0, uIntro);
        vec3 pos = mix(wall, mix(smallLock, base, bloom), descend);
        // Дыхание: дешёвый шум из синусов
        float ph = aSeed.x;
        pos.x += sin(uTime * 0.9 + ph + pos.y * 0.8) * 0.12;
        pos.y += cos(uTime * 0.7 + ph * 1.3 + pos.x * 0.6) * 0.10;
        pos.z += sin(uTime * 0.5 + ph + pos.x) * 0.12;
        // Мышь-отталкивание (мировые единицы)
        vec2 d = pos.xy - uMouse;
        float dist = length(d);
        float R = 1.6;
        if (dist < R && dist > 0.001) {
          float f = (1.0 - dist / R); f *= f;
          pos.xy += normalize(d) * f * 0.9;
        }
        // Срез 0.30-0.48: лезвие сверху вниз, ниже — осыпание
        float cut = mix(4.5, -4.5, smoothstep(0.30, 0.48, uScroll));
        float below = 1.0 - smoothstep(cut - 0.6, cut + 0.4, pos.y);
        float fall = below * smoothstep(0.30, 0.48, uScroll);
        pos.y -= fall * (2.0 + aSeed.y);
        pos.x += fall * sin(ph * 3.0 + uTime * 2.0) * 0.5;
        // Голливудская волна 0.55-0.75: широкие колебания
        float wave = smoothstep(0.55, 0.75, uScroll);
        float waveOffset = sin(pos.y * 1.6 + uTime * 1.8 + ph) * 0.6 * wave;
        pos.x += waveOffset;
        // Салют: радиальный взрыв с затуханием
        vec3 dir = pos - vec3(0.0, 0.5, -1.0);
        float dl = max(length(dir), 0.001);
        pos += (dir / dl) * uSuccess * (2.5 + aSeed.y * 2.0);
        // Дорогой глянец: псевдо-нормаль окружности локона + софит справа-сверху
        // (+0.001 в знаменателе: страховка от NaN при точном нуле)
        vec3 normal = normalize(vec3(pos.x, 0.0, pos.z + 0.5) + vec3(0.001, 0.0, 0.0));
        vec3 lightDir = normalize(vec3(1.0, 0.5, 1.0));
        float specular = pow(max(dot(normal, lightDir), 0.0), 8.0);
        // Мокрая полоса 0.15-0.30 (сканирование при мытье на Услугах)
        float wetY = (pos.y - mix(4.5, -4.5, smoothstep(0.15, 0.3, uScroll))) * 1.5;
        float wet = exp(-wetY * wetY);
        // Финальный глянец
        vGloss = (specular * wave * 2.2) + (wet * smoothstep(0.15, 0.3, uScroll) * 2.0) + (uSuccess * 1.5);
        vAlpha = (1.0 - fall * 0.92) * (0.35 + 0.65 * uIntro);
        vTint = aSeed.z;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = aSeed.y * uPixelRatio * (90.0 / -mv.z) * (1.0 + uSuccess * 0.8);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uTintA, uTintB;
      varying float vAlpha; varying float vTint; varying float vGloss;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float m = smoothstep(0.5, 0.1, length(c));
        vec3 col = mix(uTintA, uTintB, vTint) * (1.0 + vGloss * 1.6);
        gl_FragColor = vec4(col, m * vAlpha * 0.22);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  // Мышь в мировых координатах
  const mouse = { x: 999, y: 999 }, mTarget = { x: 999, y: 999 };
  addEventListener('pointermove', (e) => {
    mTarget.x = (e.clientX / innerWidth - 0.5) * 2 * halfW;
    mTarget.y = -(e.clientY / innerHeight - 0.5) * 2 * halfH;
  }, { passive: true });
  addEventListener('pointerleave', () => { mTarget.x = 999; mTarget.y = 999; });

  // Салют-триггер: window.__pfpSalute(). Отладка E2E: window.__pfpLock.
  let successT0 = -10;
  window.__pfpSalute = () => { successT0 = perfT(); };
  window.__pfpLock = { uniforms, renderer, get count() { return COUNT; } };
  const perfT = () => performance.now() / 1000;

  function scrollP() {
    const max = document.documentElement.scrollHeight - innerHeight;
    return max > 0 ? Math.min(Math.max(scrollY / max, 0), 1) : 0;
  }

  if (reduced || off) { // статика: вуаль без анимации
    uniforms.uIntro.value = 1;
    renderer.render(scene, camera);
    setStatus('Анимация выключена');
    return;
  }

  // --- Губернатор: ступенчатый контур управления. Каждый плохой замер (окно 1.5с):
  //   точек ×0.8 + кап ниже; назад — когда упираемся в кап (запас есть).
  //   Пол: последняя ступень + fps<10 дважды -> выкл.
  const CAPS = [0, 30, 24, 18, 15, 12, 10]; // 0 = без ограничения
  let level = 0, frames = 0, fpsAcc = 0, killStreak = 0, disabled = false;
  let fpsCap = 0;
  let last = performance.now(), t0 = last;
  const introLen = 3.2; // медленный вход: стена волос -> прядь -> вуаль

  function loop(now) {
    requestAnimationFrame(loop);
    if (disabled) return;
    if (fpsCap && now - last < 1000 / fpsCap) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    frames++; fpsAcc += dt;
    if (fpsAcc >= 1.5) {
      const fps = frames / fpsAcc;
      frames = 0; fpsAcc = 0;
      const maxed = level >= CAPS.length - 1;
      if (fps < 10) {
        killStreak++;
        if (maxed && killStreak >= 2) {           // пол: дальше снижать некуда -> гасим
          disabled = true;
          renderer.domElement.style.opacity = '0';
          setStatus('3D выключен (низкий FPS)');
          return;
        }
        if (!maxed) { level++; applyLevel(); killStreak = 0; }
      } else {
        killStreak = 0;
        if (fps < 28 && !maxed) { level++; applyLevel(); }                        // просадка -> ступень вниз
        else if (fpsCap > 0 && fps >= fpsCap - 1 && level > 0) { level--; applyLevel(); } // запас -> ступень вверх
      }
    }

    const t = (now - t0) / 1000;
    mouse.x += (mTarget.x - mouse.x) * 0.08;
    mouse.y += (mTarget.y - mouse.y) * 0.08;
    uniforms.uTime.value = t;
    uniforms.uMouse.value.set(mouse.x, mouse.y);
    uniforms.uScroll.value = scrollP();
    uniforms.uIntro.value = Math.min(t / introLen, 1);
    const st = (t - successT0) / 2.5; // салют ~2.5с
    uniforms.uSuccess.value = (st >= 0 && st <= 1) ? Math.sin(st * Math.PI) : 0;
    driveScissors(uniforms.uScroll.value, t);
    renderer.render(scene, camera);
  }

  // Ножницы: идут по линии среза шейдера (та же формула), щёлкают лезвиями
  const scissorsEl = document.getElementById('scissors');
  const halfH12 = Math.tan(48 * 0.5 * Math.PI / 180) * 12; // глубина z=-1 при camera.z=11
  function sstep(a, b, x) {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  }
  function driveScissors(scroll, t) {
    if (!scissorsEl) return;
    const p = sstep(0.30, 0.48, scroll); // прогресс среза 0..1
    if (p <= 0 || p >= 1) {
      scissorsEl.style.opacity = '0';
      return;
    }
    const cutY = 4.5 + (-4.5 - 4.5) * p;
    const cssY = (0.5 - (cutY / halfH12) / 2) * innerHeight;
    const cssX = (0.5 + (p - 0.5) * 0.3) * innerWidth;
    scissorsEl.style.opacity = String(Math.sin(p * Math.PI));
    scissorsEl.style.transform = `translate(${cssX - 48}px, ${cssY - 48}px)`;
    scissorsEl.style.setProperty('--snip', (Math.sin(t * 9) * 13 * Math.sin(p * Math.PI)).toFixed(1));
  }

  function applyLevel() {
    const frac = Math.pow(0.8, level);
    const shown = Math.max(2000, Math.floor(COUNT * frac));
    geo.setDrawRange(0, shown);
    fpsCap = CAPS[level];
    setStatus(`3D: ~${Math.round(shown / 1000)}k · ${fpsCap || 'max'} fps`);
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  requestAnimationFrame(loop);
}

function setStatus(t) {
  const el = document.getElementById('particles-toggle');
  if (el) el.textContent = t;
}
