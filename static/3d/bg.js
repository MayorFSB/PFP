// Фоновый свет сцены: тёплое радиальное пятно позади пучка.
//
// Раньше фон был чисто чёрным — локон висел в пустоте, контровой rim-light
// не читался, кадр выглядел плоским. Одно мягкое пятно за волосами даёт
// «студийную» глубину: силуэт пучка отделяется от фона, а края пряди
// подсвечиваются контровым светом.
//
// Плоскость — НЕ спрайт: растянута на весь экран позади сцены (z=-5),
// градиент считается в фрагменте из мировых координат, никаких текстур
// (правило репозитория: бинарные ассеты в git не кладутся).
import * as THREE from 'three';
import { scene } from './core.js';

const geo = new THREE.PlaneGeometry(46, 28);
const mat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  depthTest: false,
  // Слабое ядро + широкий тёплый ореол. Цвета подобраны под --acc (#e8b34b),
  // но приглушены до «света в дымке», а не лампы.
  uniforms: {
    uCore: { value: new THREE.Vector3(0.135, 0.095, 0.048) },   // тёплое ядро
    uHalo: { value: new THREE.Vector3(0.045, 0.033, 0.020) },   // широкий ореол
  },
  vertexShader: `
    varying vec2 vWorld;
    void main() {
      vWorld = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 uCore, uHalo;
    varying vec2 vWorld;
    void main() {
      // Центр слегка выше середины — свет «из окна студии» сверху-сзади.
      vec2 c = vWorld - vec2(0.0, 0.6);
      // Два гаусса: узкое яркое ядро и широкое мягкое поле.
      float dCore = exp(-dot(c, c) * 0.030);
      float dHalo = exp(-dot(c, c) * 0.0055);
      // Лёгкая вертикальная асимметрия: свет падает сверху.
      dCore *= 1.0 + 0.25 * smoothstep(0.0, -8.0, c.y);
      vec3 col = uCore * dCore + uHalo * dHalo;
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const plane = new THREE.Mesh(geo, mat);
plane.position.set(0, 0, -5);
plane.renderOrder = -1;
plane.frustumCulled = false;
scene.add(plane);

// Фон канваса = --bg из style.css. Композер рендерит в непрозрачный таргет,
// без этого прозрачный фон после bloom превращается в чёрный и на фоне сайта
// #0f0e0c виден шов.
scene.background = new THREE.Color(0x0f0e0c);
