// ЭТАП 0 — появление.
//
// ТЗ: волосы проявляются плавно сверху вниз строго по центру, отрисовка не
// меняется, меняются лишь состояния. Плетение нитей (uWeave) и гашение
// завитости/ветвления (uCurl) — здесь.
//
// Появление по высоте (grow/reveal) живёт в шейдере hair.js и управляется
// uniform'ом uIntro, который ставит main.js: он зависит от времени загрузки,
// а не от скролла, и к фазам не относится.
import * as THREE from 'three';
import { uniforms } from '../hair.js';
import { TL } from '../config.js';

export default {
  id: 0,
  name: 'появление',
  tl: TL.weaveIn,

  apply(p) {
    // Плетение нитей: 0 на входе → 1 к стадии «локон».
    uniforms.uWeave.value = THREE.MathUtils.smoothstep(p, TL.weaveIn[0], TL.weaveIn[1]);
    // Завитость и ветвление — только в начальных стадиях, к мытью исчезают.
    uniforms.uCurl.value = 1 - THREE.MathUtils.smoothstep(p, TL.curlOff[0], TL.curlOff[1]);
  },
};
