import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

export function createAvatar(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 30);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.minDistance = 0.7; controls.maxDistance = 8;
  controls.maxPolarAngle = Math.PI * 0.85;
  scene.add(new THREE.HemisphereLight(0xfff6ff, 0x9585b2, 2));
  const light = new THREE.DirectionalLight(0xfff7ee, 2.5);
  light.position.set(2, 3, 4); scene.add(light);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(0.7, 64), new THREE.MeshBasicMaterial({ color: 0x9d83b3, transparent: true, opacity: 0.12, depthWrite: false }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.005; scene.add(floor);
  const loader = new GLTFLoader();
  loader.register(parser => new VRMLoaderPlugin(parser));
  const offset = new THREE.Quaternion();
  let vrm = null, head = null, chest = null, headBase = null, chestBase = null;
  let last = { mouth: 0, expression: 'neutral', nod: 0, tilt: 0, blink: 0 };
  let nextBlink = 3, blinkStart = -10;
  const resize = () => {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);
  resize();
  function reset() {
    if (vrm?.expressionManager) for (const name of ['aa', 'happy', 'surprised', 'blink']) vrm.expressionManager.setValue(name, 0);
    if (head) head.quaternion.copy(headBase);
    if (chest) chest.quaternion.copy(chestBase);
    last = { mouth: 0, expression: 'neutral', nod: 0, tilt: 0, blink: 0 };
  }
  async function load(bytes) {
    const gltf = await loader.parseAsync(bytes, '');
    const next = gltf.userData.vrm;
    if (!next) { VRMUtils.deepDispose(gltf.scene); throw new Error('文件不包含可用的 VRM 角色'); }
    reset();
    if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
    vrm = next;
    VRMUtils.rotateVRM0(vrm);
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    vrm.scene.traverse(object => { object.frustumCulled = false; });
    const bone = name => vrm.humanoid.getNormalizedBoneNode(name);
    head = bone('head'); chest = bone('chest') || bone('spine');
    headBase = head?.quaternion.clone(); chestBase = chest?.quaternion.clone();
    for (const side of ['left', 'right']) {
      const arm = bone(`${side}UpperArm`), forearm = bone(`${side}LowerArm`);
      // VRM0/1 can have opposite rest-axis directions; lower toward the actual forearm.
      if (arm && forearm) arm.rotation.z = -Math.sign(forearm.position.x) * 1.15;
    }
    if (vrm.lookAt) vrm.lookAt.target = camera;
    scene.add(vrm.scene); vrm.update(0);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const height = box.max.y - box.min.y;
    const target = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y + height * 0.57, 0);
    controls.target.copy(target);
    camera.position.set(target.x, target.y + height * 0.04, Math.max(2, height * 2.15));
    controls.update();
    reset();
    // rotateVRM0 and the rest pose changed world space after the loader initialized spring tails.
    vrm.scene.updateMatrixWorld(true);
    vrm.springBoneManager?.reset();
    return { name: vrm.meta?.name || vrm.meta?.title || '本地 VRM 模型', version: vrm.meta?.metaVersion,
      expressions: ['aa', 'happy', 'surprised', 'blink'].filter(name => vrm.expressionManager?.getExpression(name)),
      head: !!head, chest: !!chest };
  }
  function update(delta, seconds, pose) {
    if (vrm) {
      if (seconds >= nextBlink) { blinkStart = seconds; nextBlink = seconds + 3.5 + Math.random() * 2; }
      const blink = Math.max(0, 1 - Math.abs((seconds - blinkStart) / 0.08 - 1));
      const manager = vrm.expressionManager;
      const expressionKey = pose.expression === 'smile' ? 'happy' : pose.expression;
      const missing = pose.expression !== 'neutral' && !manager?.getExpression(expressionKey);
      const expression = missing ? 'neutral' : pose.expression;
      manager?.setValue('aa', pose.mouth);
      manager?.setValue('happy', expression === 'smile' ? 0.65 : 0);
      manager?.setValue('surprised', expression === 'surprised' ? 0.7 : 0);
      manager?.setValue('blink', blink);
      if (head) head.quaternion.copy(headBase).multiply(offset.setFromEuler(new THREE.Euler(pose.nod, 0, pose.tilt)));
      if (chest) chest.quaternion.copy(chestBase).multiply(offset.setFromEuler(new THREE.Euler(0.008 * Math.sin(seconds * 1.8), 0, 0)));
      vrm.update(delta);
      last = { ...pose, expression, requestedExpression: pose.expression, fallback: missing ? `missing_${expressionKey}` : null, blink };
    }
    controls.update(); renderer.render(scene, camera);
  }
  return { load, reset, update, reading: () => ({ loaded: !!vrm, ...last,
    actualMouth: vrm?.expressionManager?.getValue('aa') ?? null,
    actualHappy: vrm?.expressionManager?.getValue('happy') ?? null,
    actualSurprised: vrm?.expressionManager?.getValue('surprised') ?? null,
    actualBlink: vrm?.expressionManager?.getValue('blink') ?? null,
    headRotation: head?.rotation.toArray().slice(0, 3) ?? null,
    chestRotation: chest?.rotation.toArray().slice(0, 3) ?? null,
    arms: vrm ? ['left', 'right'].map(side => ({
      shoulderY: vrm.humanoid.getRawBoneNode(`${side}UpperArm`)?.getWorldPosition(new THREE.Vector3()).y,
      handY: vrm.humanoid.getRawBoneNode(`${side}Hand`)?.getWorldPosition(new THREE.Vector3()).y,
    })) : [],
    springRotations: vrm ? [...(vrm.springBoneManager?.joints || [])].map(joint => joint.bone.quaternion.toArray()) : [],
    drawCalls: renderer.info.render.calls }) };
}
