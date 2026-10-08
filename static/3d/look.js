// Дизайн-код мытья: живой объект со значениями по умолчанию (= текущее
// поведение). `look-wash.json` рядом перекрывает их после загрузки — правка
// чисел в JSON меняет сцену без кода. Потребители: phase2 (uniform'ы),
// director (калибровка пузырей). fetch не блокирует: первые кадры идут на
// дефолтах, которые равны JSON, так что видимого скачка нет.
export const look = {
  hair: { wetDarken: 0.35, wetGloss: 0.8 },
  streams: { alpha: 1.0 },
  mist: { alpha: 1.0 },
  drips: { share: 0.45 },
  bubbles: { maxPx: 75, minPx: 23 },
};

fetch('/static/3d/look-wash.json')
  .then((r) => r.json())
  .then((j) => {
    for (const k of Object.keys(j)) {
      if (k.startsWith('_')) continue;
      if (look[k] && typeof j[k] === 'object') Object.assign(look[k], j[k]);
    }
  })
  .catch(() => {});
