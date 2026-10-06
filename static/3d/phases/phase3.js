// ЭТАП 3 — стрижка.
//
// ТЗ:
//   1. волосы становятся сухими (0–20%)
//   2. ножницы справа от волос (10–90%)
//   3. спускаясь вниз, ножницы смыкаются и размыкаются 3–4 раза за всё время,
//      в момент смыкания под створками появляются падающие частицы (20–80%)
//   4. частицы падающих волос (20–80%)
//
// Владеет: uCut, ножницами (DOM) и их производными — uSnip, uScissorX/Y.
//
// Сам разрез прядей живёт в шейдере hair.js (TL.cut) и сетку частиц не
// повторяет: ножницы едут по TL.cut, частицы появляются по TL.cutFx.
import * as THREE from 'three';
import { cutBits } from '../particles.js';
import { updateScissors } from '../tools.js';
import { TL } from '../config.js';

export default {
  id: 3,
  name: 'стрижка',
  tl: TL.cutFx,

  apply(p, t) {
    // Срезанные волоски живут на этапе стрижки.
    const cutVis = THREE.MathUtils.smoothstep(p, TL.cutFx[0], TL.cutFx[1])
      * (1 - THREE.MathUtils.smoothstep(p, TL.cutFx[2], TL.cutFx[3]));
    cutBits.material.uniforms.uCut.value = cutVis;
    cutBits.visible = cutVis > 0.01;

    updateScissors(p, t);
  },
};
