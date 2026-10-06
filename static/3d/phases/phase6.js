// ЭТАП 6 — результат, три подэтапа.
//
// ТЗ:
//   1. волосы с укладкой (0–30%)
//   2. акцентные блески, скользящие по всей длине волос (30–60%)
//   3. лёгкий блеск частиц на волосах и между ними, финал (60–100%)
//
// Владеет: камерой (облёт), uGlint/uGlintY (скользящий блик), uGlitter,
// вкладом в цветокоррекцию.
//
// Блик СПЕЦИАЛЬНЫЙ и это осознанное отступление от буквального ТЗ, где предлагался
// THREE.SpotLight. Нити рисует кастомный ShaderMaterial, и в его конвейере нет
// ни одного источника света Three.js — SpotLight просто не на что повлияет.
// Поэтому используется Вариант Б: полоса едет по высоте (vY) и усиливает
// лепесток Marschner R, который отвечает за чёткий продольный блик.
import * as THREE from 'three';
import { uniforms } from '../hair.js';
import { camera, CAM_BASE, CAM_TARGET } from '../core.js';
import { glitter } from '../particles.js';
import { TOP, TL } from '../config.js';

const RESULT_FROM = TL.result[0];
const RESULT_TO = TL.result[1];
const SCAN_TOP = TOP + 0.4;
const SCAN_BOTTOM = -TOP * 0.42;

// Позиция камеры до облёта и после него. Смещение считается вручную через
// halfViewW/halfViewH: камера не вращается, поэтому NDC = offset / half.
export const CAM_ORBIT = { x: 0.0, y: 0.0 };

export default {
  id: 6,
  name: 'результат',
  tl: TL.result,

  apply(p) {
    const sR = THREE.MathUtils.clamp((p - RESULT_FROM) / (RESULT_TO - RESULT_FROM), 0, 1);
    const S = THREE.MathUtils;

    // Подэтап 1: форма уже зафиксирована (uGlue/uGloss на 1.0). Плавно
    // уводим камеру вправо и чуть вниз — облёт должен быть незаметным.
    // При sR = 0 всё обнуляется, поэтому камера возвращается на базу, если
    // пользователь прокрутит вверх.
    const orb = S.smoothstep(sR, 0.04, 0.92);
    CAM_ORBIT.x = orb * 0.62;
    CAM_ORBIT.y = -orb * 0.30;
    camera.position.set(CAM_BASE.x + CAM_ORBIT.x, CAM_BASE.y + CAM_ORBIT.y, CAM_BASE.z);
    camera.lookAt(CAM_TARGET);

    // Подэтап 2: полоса сканирования идёт сверху вниз и возвращается наверх.
    // sawtooth вместо smoothstep, иначе на краях мгновенный простой.
    const sweep = (sR - TL.resultSweep[0]) / (TL.resultSweep[1] - TL.resultSweep[0]);
    let scan = 0;
    if (sweep > 0 && sweep < 1) {
      const cyc = sweep * 2.0;
      const tri = cyc - Math.floor(cyc);
      scan = tri < 0.5 ? tri * 2.0 : 2.0 - tri * 2.0;
    }
    uniforms.uGlint.value = S.smoothstep(sweep, 0.0, 0.16)
      * (1 - S.smoothstep(sweep, 0.86, 1.0));
    uniforms.uGlintY.value = THREE.MathUtils.lerp(SCAN_TOP, SCAN_BOTTOM, scan);

    // Подэтап 3: блестки. Растут до 1.0 и удерживаются в финальном кадре.
    uniforms.uGlitter.value = S.smoothstep(sR, TL.resultGlitter[0], TL.resultGlitter[1]);
    glitter.visible = uniforms.uGlitter.value > 0.01;
    // Стабилизация к 100%: мерцание не замирает полностью, а лишь выравнивается
    // по амплитуде — иначе финальный кадр выглядит «мёртвым».
    if (sR > 0.9) uniforms.uGlitter.value *= 1.0 - (sR - 0.9) * 0.25;
  },
};
