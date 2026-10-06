// ЭТАП 4 — укладка, 7 подфаз.
//
// ТЗ:
//   0. волосы прямые (0–20%)
//   1. материализуется утюжок справа от волос (20–30%)
//   2. одна прядь обвивается вокруг рабочей области (30–40%)
//   3. утюжок смыкает створки (40–50%)
//   4. пар и белый/серый дымок в точке контакта (50–60%)
//   5. утюжок скользит вниз, разжимая створки, отпускает прядь (60–72%)
//   6. прядь становится завитой (67–80%)
//   7. все пряди постепенно становятся завитыми (80–100%)
//
// Владеет: утюжком (DOM), uWrap, uCurlDone, uIronGlow, uIronPos, вкладом в
// uSteam. Утюжок — единственный инструмент, который пишет в состояние ВОЛОС
// (обвивает и завивает прядь), поэтому он живёт в hair-shader'е.
import * as THREE from 'three';
import { uniforms } from '../hair.js';
import { steam } from '../particles.js';
import { updateIron } from '../tools.js';
import { TL } from '../config.js';

export default {
  id: 4,
  name: 'укладка',
  tl: TL.style,

  apply(p) {
    // Утюжок ставит uWrap/uCurlDone/uIronGlow/uIronPos и ведёт себя сам.
    updateIron(p);

    // Вклад в фоновый пар: на укладке он сильный, сетка steamFx шире
    // самой стадии style.
    const styleSteam = THREE.MathUtils.smoothstep(p, TL.steamFx[0], TL.steamFx[1])
      * (1 - THREE.MathUtils.smoothstep(p, TL.steamFx[2], TL.steamFx[3]));
    steam.material.uniforms.uSteam.value = Math.max(
      steam.material.uniforms.uSteam.value, styleSteam,
    );
  },
};
