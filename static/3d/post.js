// Пост-обработка: EffectComposer (RenderPass + UnrealBloomPass + OutputPass).
//
// Что даёт:
//  • ACES-тонмаппинг (OutputPass) вместо «сырого» вывода: блики закатываются
//    плавно, без клиппинга в белое, цвета глубже.
//  • Bloom: зеркальные блики волос (R-лепесток Marschner) и фоновое пятно
//    мягко светятся — «салонный» рендер вместо плоских спрайтов.
//
// Композер один на сцену; main.js вызывает composer.render() вместо
// renderer.render() и composer.setSize() на resize.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { renderer, scene, camera } from './core.js';

// ACES применяется в OutputPass при финальном копировании (renderer.toneMapping).
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Компенсация затемнения ACES: у него shoulder ~0.8, средняя серость уезжает.
renderer.toneMappingExposure = 1.15;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

// Порог 0.55: светятся только блики и фоновое ядро, тело волос не мылится.
// strength/radius сдержанные — «дымка света», не неон.
const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.55, 0.55);
composer.addPass(bloom);
composer.addPass(new OutputPass());

export { composer };
