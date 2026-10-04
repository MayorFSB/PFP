// Локон PFP: ЛИНИИ волос (LineSegments, 1 draw call) + стадии-состояния по скроллу.
// Пряди непрерывные — как настоящие волосы; филлрейт в разы ниже спрайтов.
// CPU за кадр: только uniform'ы. Вся физика — GLSL.
// Губернатор-лесенка: плохой замер -> вершин ×0.8 + кап ниже (30/24/18/15/12/10),
// назад — когда упираемся в кап; пол + fps<10 дважды -> выкл.
import * as THREE from 'three';

const mount = document.getElementById('hero3d');
if (mount) init();

function init() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const off = localStorage.getItem('pfp-particles-off') === '1';
  const isMobile = matchMedia('(max-width:700px)').matches;
  // ?pfp_strands=N — ручной режим (50..6000), удобно и для отладки стадий
  const qp = new URLSearchParams(location.search).get('pfp_strands');
  const STRANDS = qp ? Math.min(Math.max(parseInt(qp, 10) || 1200, 50), 6000)
    : (isMobile ? 1200 : 5000);
  const SEG = isMobile ? 14 : 22; // сегментов на прядь
  const LANES = 3; // линий в жгуте: WebGL даёт только 1px, толщину набираем смещением

  const renderer = new THREE.WebGLRenderer({ antialias: !isMobile, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 60);
  camera.position.set(0, 0, 11);
  const halfH = Math.tan(camera.fov * 0.5 * Math.PI / 180) * camera.position.z;
  const halfW = halfH * camera.aspect;

  // --- Геометрия: непрерывные пряди, S-волна по референсам ---
  const VPS = SEG + 1; // вершин на прядь
  const NV = STRANDS * LANES * VPS;
  const posArr = new Float32Array(NV * 3);
  const tArr = new Float32Array(NV);
  const laneArr = new Float32Array(NV);
  const seedArr = new Float32Array(NV * 4);
  const idx = new Uint32Array(STRANDS * SEG * 2 * LANES);
  function lockPos(s, t, out) {
    const phi = s * 2.39996; // 137.5° — филлотаксис, плотный центр
    const rootR = 0.5 + Math.sqrt(s / STRANDS) * 1.7;
    const taper = 1.0 - t * 0.25;
    const bend = Math.sin(t * 6.9 + phi * 0.5) * 1.05 * t; // 2 крупных изгиба
    const a = phi + t * 1.2; // слабый поворот, не спираль
    const micro = Math.sin(t * 30.0 + s * 12.0) * 0.04;
    out[0] = Math.cos(a) * rootR * taper + bend + micro;
    out[1] = 5.2 - t * 10.4; // +5.2..-5.2: во весь экран, из хедера
    out[2] = Math.sin(a) * rootR * taper * 0.85;
  }
  const tmp = [0, 0, 0];
  for (let s = 0; s < STRANDS; s++) {
    for (let lane = 0; lane < LANES; lane++) {
      const lo = lane - (LANES - 1) / 2; // -1, 0, 1: смещение жгута
      for (let k = 0; k <= SEG; k++) {
        const vi = (s * LANES + lane) * VPS + k, t = k / SEG;
        lockPos(s, t, tmp);
        posArr[vi * 3 + 0] = tmp[0];
        posArr[vi * 3 + 1] = tmp[1];
        posArr[vi * 3 + 2] = tmp[2];
        tArr[vi] = t;
        laneArr[vi] = lo;
        seedArr[vi * 4 + 0] = s * 0.15 + t * 4.0; // фаза по пряди
        seedArr[vi * 4 + 1] = 0.4 + (1.0 - t * 0.5) * Math.random() * 1.2;
        seedArr[vi * 4 + 2] = (s / STRANDS) * 0.4 + Math.random() * 0.6;
        seedArr[vi * 4 + 3] = 1.0 + Math.random() * 1.5;
        if (k < SEG) {
          const ii = ((s * LANES + lane) * SEG + k) * 2;
          idx[ii] = vi;
          idx[ii + 1] = vi + 1;
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(tArr, 1));
  geo.setAttribute('aLane', new THREE.BufferAttribute(laneArr, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seedArr, 4));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const INDEX_TOTAL = idx.length;
  const STRAND_BLOCK = SEG * 2 * LANES; // индексов на прядь: режем целыми прядями

  const uniforms = {
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2(999, 999) },
    uScroll: { value: 0 },
    uIntro: { value: 0 },
    uSuccess: { value: 0 },
    uTintA: { value: new THREE.Color('#e8b34b') },
    uTintB: { value: new THREE.Color('#f5f1e8') },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aT; attribute float aLane; attribute vec4 aSeed;
      uniform float uTime, uScroll, uIntro, uSuccess;
      uniform vec2 uMouse;
      varying float vAlpha; varying float vTint; varying float vGloss;
      varying float vWet; varying float vDrop;
      void main() {
        // Локон-константа: форма не меняется при скролле, только состояния.
        // Окна: рост 0-0.85 интро; мытьё 0.15-0.30; срез 0.30-0.44;
        // утюжок 0.46-0.58; волна 0.58-0.72; лак 0.74-0.86; финал 0.86+
        vec3 pos = position;
        // Жгут: смещение линий для толщины (драйвер даёт только 1px)
        pos.x += aLane * 0.02;
        pos.z += aLane * 0.013;
        // Интро: рост сверху вниз из хедера (reveal по линии роста)
        float growY = mix(7.0, -7.0, smoothstep(0.0, 0.85, uIntro));
        float reveal = smoothstep(growY - 0.8, growY + 0.8, pos.y);
        // Дыхание: дешёвый шум из синусов (медленное, минимальное)
        float ph = aSeed.x;
        pos.x += sin(uTime * 0.45 + ph + pos.y * 0.8) * 0.08;
        pos.y += cos(uTime * 0.35 + ph * 1.3 + pos.x * 0.6) * 0.07;
        pos.z += sin(uTime * 0.25 + ph + pos.x) * 0.08;
        // Курсор: не дыра, а свет — мягкое усиление блика рядом (без смещения)
        vec2 md = pos.xy - uMouse;
        float mGlow = exp(-dot(md, md) * 0.8);
        // Срез 0.30-0.44: лезвие сверху вниз; длина сохраняется, осыпаются обрезки
        float cut = mix(5.5, -5.5, smoothstep(0.30, 0.44, uScroll));
        float below = 1.0 - smoothstep(cut - 0.6, cut + 0.4, pos.y);
        float fall = below * smoothstep(0.30, 0.44, uScroll);
        pos.y -= fall * (2.0 + aSeed.y);
        pos.x += fall * sin(ph * 3.0 + uTime * 2.0) * 0.5;
        // Утюжок 0.46-0.58: пряди выравниваются, сужаются, глянец растёт
        float straight = smoothstep(0.46, 0.58, uScroll);
        pos.x *= (1.0 - 0.12 * straight);
        // Голливудская волна 0.58-0.72: широкие колебания
        float wave = smoothstep(0.58, 0.72, uScroll);
        float waveOffset = sin(pos.y * 1.6 + uTime * 1.8 + ph) * 0.6 * wave;
        pos.x += waveOffset * (1.0 - 0.5 * straight);
        // Салют: радиальный взрыв с затуханием
        vec3 dir = pos - vec3(0.0, 0.5, -1.0);
        float dl = max(length(dir), 0.001);
        pos += (dir / dl) * uSuccess * (2.5 + aSeed.y * 2.0);
        // Дорогой глянец: псевдо-нормаль окружности локона + софит справа-сверху
        vec3 normal = normalize(vec3(pos.x, 0.0, pos.z + 0.5) + vec3(0.001, 0.0, 0.0));
        vec3 lightDir = normalize(vec3(1.0, 0.5, 1.0));
        float specular = pow(max(dot(normal, lightDir), 0.0), 8.0);
        // Мокрая полоса 0.15-0.30: затемнение + капли-блёстки
        float wetY = (pos.y - mix(4.5, -4.5, smoothstep(0.15, 0.3, uScroll))) * 1.5;
        float wet = exp(-wetY * wetY) * smoothstep(0.15, 0.3, uScroll);
        vWet = wet;
        vDrop = step(0.93, fract(aSeed.z * 13.7)) * wet;
        // Лак 0.74-0.86 + финал: сверх-глянец
        float lacq = smoothstep(0.74, 0.86, uScroll);
        // Финальный глянец
        vGloss = (specular * (wave * 2.2 + lacq * 1.8 + straight * 0.6))
          + (wet * 2.0) + (uSuccess * 1.5) + (mGlow * 0.9) + (lacq * 0.6);
        vAlpha = (1.0 - fall * 0.92) * reveal;
        vTint = aSeed.z;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uTintA, uTintB;
      varying float vAlpha; varying float vTint; varying float vGloss;
      varying float vWet; varying float vDrop;
      void main() {
        vec3 col = mix(uTintA, uTintB, vTint) * (1.0 + vGloss * 1.6);
        col = mix(col, col * vec3(0.55, 0.42, 0.30), vWet * 0.7); // мокрое затемнение
        col += vec3(0.65, 0.8, 1.0) * vDrop * (0.8 + vGloss);     // капли
        gl_FragColor = vec4(col, vAlpha * 0.05);
      }`,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  scene.add(lines);

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
  window.__pfpLock = { uniforms, renderer, get strands() { return STRANDS; } };
  const perfT = () => performance.now() / 1000;

  function scrollP() {
    const max = document.documentElement.scrollHeight - innerHeight;
    return max > 0 ? Math.min(Math.max(scrollY / max, 0), 1) : 0;
  }

  if (reduced || off) { // статика: готовый локон без анимации
    uniforms.uIntro.value = 1;
    renderer.render(scene, camera);
    setStatus('Анимация выключена');
    return;
  }

  // --- Губернатор-лесенка: плохой замер -> вершин ×0.8 + кап ниже ---
  const CAPS = [0, 30, 24, 18, 15, 12, 10]; // 0 = без ограничения
  let level = 0, frames = 0, fpsAcc = 0, killStreak = 0, disabled = false;
  let fpsCap = 0;
  let last = performance.now(), t0 = last;
  const introLen = 3.2; // медленный вход: рост волос из хедера

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
        if (maxed && killStreak >= 2) {
          disabled = true;
          renderer.domElement.style.opacity = '0';
          setStatus('3D выключен (низкий FPS)');
          return;
        }
        if (!maxed) { level++; applyLevel(); killStreak = 0; }
      } else {
        killStreak = 0;
        if (fps < 28 && !maxed) { level++; applyLevel(); }
        else if (fpsCap > 0 && fps >= fpsCap - 1 && level > 0) { level--; applyLevel(); }
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
    renderer.render(scene, camera);
  }

  function applyLevel() {
    const frac = Math.pow(0.8, level);
    const shown = Math.max(STRAND_BLOCK, Math.floor(INDEX_TOTAL * frac / STRAND_BLOCK) * STRAND_BLOCK);
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
