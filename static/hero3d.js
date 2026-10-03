// 3D-волосы: Three.js, только главная. Адаптация по FPS:
//   < 30 fps -> замедляем (cap 30 -> 24 -> 18 fps)
//   < 20 fps стабильно -> отключаем тяжёлую анимацию
// Уважает prefers-reduced-motion и кнопку отключения.
import * as THREE from 'three';

const mount = document.getElementById('hero3d');
if (mount) init();

function init() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const off = localStorage.getItem('pfp-particles-off') === '1';
  if (reduced || off) return;

  // Качество: стартовое число точек, дальше по FPS
  const isMobile = matchMedia('(max-width:700px)').matches;
  let strandCount = isMobile ? 26 : 44;   // нити
  let perStrand = isMobile ? 26 : 38;  // точек в нити

  const renderer = new THREE.WebGLRenderer({ antialias: !isMobile, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0f0e0c, 0.055);
  const camera = new THREE.PerspectiveCamera(48, mount.clientWidth / mount.clientHeight, 0.1, 60);
  camera.position.set(0, 0, 11);

  const group = new THREE.Group();
  scene.add(group);

  // Материал: тонкие светящиеся нити
  function makeStrandGeometry(sIdx) {
    const pos = new Float32Array(perStrand * 3);
    const seed = sIdx * 0.618;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return geo;
  }

  function strandBase(sIdx) {
    const seed = sIdx * 0.618;
    const angle = seed * Math.PI * 2;
    const radius = 2.4 + Math.sin(seed * 3.1) * 1.1;
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.62,
      z: -Math.abs(Math.sin(seed * 1.7)) * 5 - 1,
      phase: seed * 6.283,
      sway: 0.5 + ((sIdx % 5) / 5) * 0.9,
    };
  }

  const strands = [];
  for (let i = 0; i < strandCount; i++) {
    const b = strandBase(i);
    const geo = makeStrandGeometry(i);
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color().setHSL(0.11, 0.75, 0.55 + (i % 4) * 0.06),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
    });
    const line = new THREE.Line(geo, mat);
    group.add(line);
    strands.push({ line, geo, ...b });
  }

  // Мышь = ветер (легкое притяжение/отталкивание)
  let wind = { x: 0, y: 0 }, target = { x: 0, y: 0 };
  addEventListener('pointermove', (e) => {
    target.x = (e.clientX / innerWidth - 0.5) * 2;
    target.y = (e.clientY / innerHeight - 0.5) * 2;
  }, { passive: true });

  function deform(t, dt) {
    wind.x += (target.x - wind.x) * 0.04;
    wind.y += (target.y - wind.y) * 0.04;
    for (const s of strands) {
      const arr = s.geo.attributes.position.array;
      for (let p = 0; p < perStrand; p++) {
        const f = p / (perStrand - 1);
        const wave = Math.sin(t * 1.1 + s.phase + f * 5.5) * 0.34 * s.sway;
        const wave2 = Math.cos(t * 0.7 + s.phase * 1.3 + f * 3.1) * 0.22 * s.sway;
        arr[p * 3 + 0] = s.x + wave + wind.x * f * 1.5;
        arr[p * 3 + 1] = s.y + wave2 + wind.y * f * 1.5 + (f - 0.5) * 2.2;
        arr[p * 3 + 2] = s.z + f * 3.4 + Math.sin(t * 0.5 + f * 4 + s.phase) * 0.3;
      }
      s.geo.attributes.position.needsUpdate = true;
    }
    group.rotation.y += (wind.x * 0.25 - group.rotation.y) * 0.05;
    group.rotation.x += (-wind.y * 0.12 - group.rotation.x) * 0.05;
  }

  // --- Адаптация по FPS ---
  let fpsCap = 0;          // 0 = без ограничения
  let frames = 0, fpsAcc = 0, lowStreak = 0, disabled = false;
  let last = performance.now();

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
      if (fps < 20) {
        lowStreak++;
        if (lowStreak >= 2) {           // стабильно низко -> гасим
          disabled = true;
          renderer.domElement.style.opacity = '0';
          setStatus('3D выключен (низкий FPS)');
          return;
        }
      } else { lowStreak = 0; }

      if (fps < 30 && fpsCap === 0) { fpsCap = 30; setStatus('3D: 30 fps'); }
      else if (fps < 26 && fpsCap === 30) { fpsCap = 24; reduceQuality(); }
      else if (fps < 22 && fpsCap === 24) { fpsCap = 18; reduceQuality(); }
      else if (fps > 55 && fpsCap > 0 && fpsCap < 30) { fpsCap = 0; setStatus('3D: максимум'); }
    }

    deform(now * 0.001, dt);
    renderer.render(scene, camera);
  }

  function reduceQuality() {
    if (strands.length <= 14) return;
    const keep = Math.floor(strands.length * 0.6);
    while (strands.length > keep) {
      const s = strands.pop();
      group.remove(s.line);
      s.geo.dispose(); s.line.material.dispose();
    }
    setStatus(`3D: ${fpsCap} fps, нитей ${strands.length}`);
  }

  addEventListener('resize', () => {
    camera.aspect = mount.clientWidth / mount.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(mount.clientWidth, mount.clientHeight);
  });

  requestAnimationFrame(loop);
}

function setStatus(t) {
  const el = document.getElementById('particles-toggle');
  if (el) el.textContent = t;
}