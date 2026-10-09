// ЭТАП 2 — мытьё (WASH v2.1).
//
// Владеет: uStraight, uWet/uWetClump/uWashFlow, uWash (частицы), uStains,
// вклад в uSteam. Shed не трогаем: отпавшие не возвращаются.
//
// uSteam ОБЩИЙ: каждая фаза только УВЕЛИЧИВАЕТ его, а director обнуляет перед
// проходом по фазам (см. resetSharedUniforms). Так значение может и упасть
// обратно — при обычном max() оно залипло бы на 1.0 навсегда.
import * as THREE from 'three';
import { uniforms } from '../hair.js';
import { steam, washLayers, streams, mist, water } from '../particles.js';
import { look } from '../look.js';
import { TL, MAX_STRANDS, PLIES } from '../config.js';

// Пятна грязи (§7.5): 6 якорей {jit, t, size} на лицевой стороне
// (sin(phase·2π) > 0.3 в покое). Верхние смываются первыми.
const STAINS = (() => {
  const F = (x) => x - Math.floor(x);
  const cand = [];
  for (let s = 0; s < MAX_STRANDS; s++) {
    const ply = s % PLIES;
    const slot = Math.floor(s / PLIES);
    const slotN = slot / Math.max(1, Math.ceil(MAX_STRANDS / PLIES) - 1);
    const phase = slotN + ply * 0.137;
    if (Math.sin(phase * 2 * Math.PI) > 0.3) cand.push(F(s * 0.2451221718));
  }
  const out = [];
  for (let i = 0; i < 6; i++) {
    const jit = cand[Math.floor(((i + 0.5) / 6) * cand.length)];
    out.push({
      jit,
      t: 0.30 + i * 0.07,
      size: 0.6 + (i % 3) * 0.2,
      off: (F(i * 7.31) - 0.5) * 0.04,   // рассинхрон появления ±0.02
      spread: i / 5,                      // порядок смыва (верхние первые)
    });
  }
  return out;
})();

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

    // WASH v2.1 §5: вес мокрости, догоняющий кламп, спуск фронта.
    const S = THREE.MathUtils.smoothstep;
    uniforms.uWet.value = S(p, TL.wet.rise[0], TL.wet.rise[1])
      * (1 - S(p, TL.wet.fall[0], TL.wet.fall[1]));
    const wet = uniforms.uWet.value;
    uniforms.uWetClump.value = S(wet, 0.35, 0.9) * wet;
    uniforms.uWashFlow.value = S(p, TL.washFlow[0], TL.washFlow[1]);

    // Пятна (§7.5.3–7.5.4): появление на curl, смыв staggered (верхние первые).
    // z несёт появление (размер × appear), w — смытость. Чистый f(p): обратный
    // скролл всё восстанавливает.
    for (let i = 0; i < 6; i++) {
      const st = STAINS[i];
      const appear = S(p, TL.stainIn[0] + st.off, TL.stainIn[1] + st.off);
      const rinseP = TL.dirtRinse[0] + st.spread * (TL.dirtRinse[1] - TL.dirtRinse[0]);
      const rinse = S(p, rinseP - 0.04, rinseP + 0.10);
      uniforms.uStains.value[i].set(st.jit, st.t, st.size * appear, rinse);
    }
    uniforms.uStainCount.value = 6;

    // Дизайн-код (look-wash.json): мокрый вид и силы систем — из JSON.
    uniforms.uWetDarken.value = look.hair.wetDarken;
    uniforms.uWetGloss.value = look.hair.wetGloss;
    streams.material.uniforms.uStreamA.value = look.streams.alpha;
    mist.material.uniforms.uMistA.value = look.mist.alpha;
    water.material.uniforms.uDripShare.value = look.drips.share;
  },
};
