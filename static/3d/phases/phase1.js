// ЭТАП 1 — «до»: грязные, непослушные, отпадают.
//
// ТЗ:
//   1. волосы появляются слегка грязными, с комками пыли и жвачкой (0–100%)
//   2. волосы непослушные, движутся паттернами в разные стороны (30–70%)
//   3. некоторые части волос отпадают (45–100%)
//
// Шейдерная поддержка — в hair.js (uDirt/uGum/uWild/uShed). Здесь только
// подокна внутри стадии PHASE.curl. Ниже стадии (q=0) всё нули — эталон
// стадии 0 не тронут. Выше стадии эффекты залипают (грязь смоется мойкой,
// жвачка снимется стрижкой — когда эти фазы будут подключены).
import * as THREE from 'three';
import { uniforms } from '../hair.js';
import { PHASE } from '../config.js';
import { gumPts } from '../gum.js';

const RANGE = PHASE.curl; // [0.08, 0.26] — стадия «локон»

export default {
  id: 1,
  name: 'до: грязные и непослушные',
  tl: RANGE,
  implemented: true,

  apply(p) {
    const S = THREE.MathUtils;
    const q = S.clamp((p - RANGE[0]) / (RANGE[1] - RANGE[0]), 0, 1);
    // 1. грязь въедается быстро и остаётся
    uniforms.uDirt.value = S.smoothstep(q, 0.0, 0.35);
    // Жвачка ОТКЛЮЧЕНА (не прошла визуал): uGum в нуле, пятно скрыто.
    // Код живёт в gum.js + hair.js (маски/склейка) — вернуть одной строкой.
    uniforms.uGum.value = 0;
    // 2. непослушность: окно 30–70%. Хаос раньше и короче: 17–37% —
    // движение не останавливается никогда, окна пересекаются.
    uniforms.uWild.value = S.smoothstep(q, 0.30, 0.40)
      * (1 - S.smoothstep(q, 0.60, 0.70));
    uniforms.uChaos.value = S.smoothstep(q, 0.17, 0.24)
      * (1 - S.smoothstep(q, 0.30, 0.37));
    // 3. отпадание: 45–100%
    uniforms.uShed.value = S.smoothstep(q, 0.45, 1.0);
    // Пятно жвачки скрыто (см. выше).
    gumPts.visible = false;
  },
};
