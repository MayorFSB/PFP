// ЭТАП 2 — мытьё.
//
// ТЗ:
//   1. волосы становятся влажными и прямыми (0–100%)
//   2. пузыри слева и справа (30–100%)
//   3. вода на волосах (20–100%)
//   4. стекающая пена (40–100%)
//   5. пар (50–100%)
//
// Владеет: uStraight, uWash (пузыри/вода/пена), вклад в uSteam (фоновый пар
// на мытье). Сильную половину uSteam на укладке добавляет этап 4.
//
// uSteam ОБЩИЙ: каждая фаза только УВЕЛИЧИВАЕТ его, а director обнуляет перед
// проходом по фазам (см. resetSharedUniforms). Так значение может и упасть
// обратно — при обычном max() оно залипло бы на 1.0 навсегда.
import * as THREE from 'three';
import { uniforms } from '../hair.js';
import { steam, washLayers, streams, mist, water } from '../particles.js';
import { look } from '../look.js';
import { TL } from '../config.js';

export default {
  id: 2,
  name: 'мытьё',
  tl: TL.washFx,

  apply(p) {
    // Мытьё раскручивает локон в прямые нити; укладка закручивает снова.
    uniforms.uStraight.value = THREE.MathUtils.smoothstep(p, TL.straightOn[0], TL.straightOn[1])
      * (1 - THREE.MathUtils.smoothstep(p, TL.straightOff[0], TL.straightOff[1]));

    // Три сущности фазы мытья: пузыри по бокам, вода в волосах, стекающая пена.
    const washVis = THREE.MathUtils.smoothstep(p, TL.washFx[0], TL.washFx[1])
      * (1 - THREE.MathUtils.smoothstep(p, TL.washFx[2], TL.washFx[3]));
    for (const pts of washLayers()) {
      pts.material.uniforms.uWash.value = washVis;
      pts.visible = washVis > 0.01;
    }

    // Вклад в фоновый пар: на мытье он слабый.
    steam.material.uniforms.uSteam.value = Math.max(
      steam.material.uniforms.uSteam.value, washVis * 0.35,
    );

    // Смыв грязи этапа 1: фаза 1 пишет uDirt=1 залипшим (q clamp), а идём
    // строго после неё — домножаем на gate мытья. К концу активной пены
    // (washFx[2]) волосы чистые. Shed не трогаем: отпавшие не возвращаются.
    const clean = THREE.MathUtils.smoothstep(p, TL.washFx[0], TL.washFx[2]);
    uniforms.uDirt.value *= 1 - clean;

    // Дизайн-код (look-wash.json): мокрый вид и силы систем — из JSON.
    uniforms.uWetDarken.value = look.hair.wetDarken;
    uniforms.uWetGloss.value = look.hair.wetGloss;
    streams.material.uniforms.uStreamA.value = look.streams.alpha;
    mist.material.uniforms.uMistA.value = look.mist.alpha;
    water.material.uniforms.uDripShare.value = look.drips.share;
  },
};
