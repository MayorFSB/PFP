// ЭТАП 5 — фиксация лаком.
//
// ТЗ:
//   1. волосы завитые (0–20%)
//   2. материализуется баллончик справа от волос (20–30%)
//   3. спрей частиц 1 (30–55%)
//   4. спрей частиц 2 (55–80%)
//   5. блеск усиливается к финалу, склеиваем 15–40% линий попарно (40–100%)
//
// Владеет: баллончиком (DOM), струями (частицы), uGloss и uGlue.
//
// uGloss/uGlue — ПОСТОЯННЫЕ свойства волос, а не эффект баллончика. Поэтому
// они считаются здесь ДО проверки видимости баллончика и никогда не
// обнуляются по ней: иначе на последних 6% стадии пряди «расклеиваются», а на
// финале hair_glued = 0, хотя по ТЗ там должно быть 1.0. Значения выросли по
// sT и держатся до конца страницы, потому что p монотонен по скроллу.
import * as THREE from 'three';
import { uniforms } from '../hair.js';
import { updateFix } from '../tools.js';
import { TL } from '../config.js';

export default {
  id: 5,
  name: 'фиксация лаком',
  tl: TL.fix,

  apply(p) {
    const sT = THREE.MathUtils.clamp(
      (p - TL.fix[0]) / (TL.fix[1] - TL.fix[0]), 0, 1,
    );
    // Считаем ДО раннего выхода updateFix: баллончик нужен не всё время
    // стадии, а лак остаётся навсегда.
    uniforms.uGloss.value = THREE.MathUtils.smoothstep(sT, TL.fixGloss[0], TL.fixGloss[1]);
    uniforms.uGlue.value = THREE.MathUtils.smoothstep(sT, TL.fixGlue[0], TL.fixGlue[1]);

    updateFix(p);
  },
};
