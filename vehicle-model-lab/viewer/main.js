import * as THREE from "../../vendor/three/three.module.js";
import { OrbitControls } from "../../vendor/three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "../../vendor/three/addons/loaders/GLTFLoader.js";

const canvas = document.querySelector("#vehicle-canvas");
const panel = canvas.parentElement;
const status = document.querySelector("#load-status");
const activity = document.querySelector("#activity-status");
const mechanicalControls = document.querySelector("#mechanical-controls");
const lightControls = document.querySelector("#light-controls");
const mechanicalCount = document.querySelector("#mechanical-count");
const lightCount = document.querySelector("#light-count");
const seatFocusToggle = document.querySelector("#seat-focus-toggle");
const seatControls = document.querySelector("#seat-controls");
const seatReset = document.querySelector("#seat-reset");

const labels = {
  front_left_door_open: "左前门",
  front_right_door_open: "右前门",
  rear_left_door_open: "左后门",
  rear_right_door_open: "右后门",
  front_left_window_open: "左前窗",
  front_right_window_open: "右前窗",
  rear_left_window_open: "左后窗",
  rear_right_window_open: "右后窗",
  front_left_handle_deploy: "左前把手",
  front_right_handle_deploy: "右前把手",
  rear_left_handle_deploy: "左后把手",
  rear_right_handle_deploy: "右后把手",
  hood_open: "前舱盖",
  tailgate_open: "尾门",
  front_wheels_steer: "前轮转向",
  wheels_roll: "车轮滚动",
  charge_port_open: "充电口",
  mirror_left_fold: "左后视镜",
  mirror_right_fold: "右后视镜",
  wipers_sweep: "雨刷扫动",
  suspension_raise: "车身升高",
  driver_seat_fore_aft: "主驾前后",
  driver_seat_height: "主驾升降",
  driver_seat_backrest_recline: "主驾靠背",
  driver_seat_headrest_height: "主驾头枕",
  daytime_running_lights: "日行灯",
  low_beams: "近光灯",
  tail_lights: "尾灯",
  left_indicator: "左转向灯",
  right_indicator: "右转向灯",
};

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(panel.clientWidth, panel.clientHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x090d11, 0.035);
const camera = new THREE.PerspectiveCamera(42, panel.clientWidth / panel.clientHeight, 0.02, 100);
camera.position.set(7.2, 4.2, 5.6);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 0.7, 0);

scene.add(new THREE.HemisphereLight(0xddefff, 0x172028, 2.2));
const key = new THREE.DirectionalLight(0xffffff, 4.5);
key.position.set(5, 7, 6);
key.castShadow = true;
scene.add(key);
const rim = new THREE.DirectionalLight(0x78c7ff, 2.2);
rim.position.set(-5, 3, -6);
scene.add(rim);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(10, 96),
  new THREE.MeshStandardMaterial({ color: 0x10161b, roughness: 0.82, metalness: 0.08 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.015;
floor.receiveShadow = true;
scene.add(floor);

let mixer;
let modelRoot;
const mechanicalState = new Map();
const lightState = new Map();
const indicatorPhase = new Map();
const seatActions = new Map();
const seatDefinitions = new Map();
const seatMaterialRestore = new Map();
const fogMaterialCache = new Map();
let seatFocusActive = false;
let savedCameraState;
let cameraTween;

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setMetrics(manifest, loadMilliseconds) {
  document.querySelector("#metric-load").textContent = `${Math.round(loadMilliseconds)} ms`;
  document.querySelector("#metric-size").textContent = formatBytes(manifest.statistics.glbFileSizeBytes);
  document.querySelector("#metric-triangles").textContent = manifest.statistics.triangles.toLocaleString("zh-CN");
  document.querySelector("#metric-materials").textContent = `${manifest.statistics.materials} / ${manifest.statistics.textures}`;
}

function fitCamera(root) {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const distance = Math.max(size.x, size.y, size.z) * 1.55;
  controls.target.copy(center).add(new THREE.Vector3(0, size.y * 0.04, 0));
  camera.position.copy(center).add(new THREE.Vector3(distance, distance * 0.48, distance * 0.82));
  camera.near = Math.max(0.01, distance / 500);
  camera.far = distance * 20;
  camera.updateProjectionMatrix();
  controls.update();
}

function prepareModel(root) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      material.side = THREE.DoubleSide;
      material.needsUpdate = true;
    }
  });
}

function createButton(container, id, onToggle) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = labels[id] || id;
  button.addEventListener("click", () => onToggle(button));
  container.append(button);
  return button;
}

function prepareSeatAction(clipName, definition, clip) {
  const action = mixer.clipAction(clip);
  action.enabled = true;
  action.clampWhenFinished = true;
  action.setLoop(THREE.LoopOnce, 1);
  action.play();
  action.paused = true;
  seatActions.set(clipName, { action, clip });
  seatDefinitions.set(clipName, definition);
  return action;
}

function bindMechanicalControls(gltf, manifest) {
  const clips = new Map(gltf.animations.map((clip) => [clip.name, clip]));
  for (const [clipName, definition] of Object.entries(manifest.animations)) {
    const clip = clips.get(clipName);
    if (!clip) throw new Error(`GLB 缺少动作 ${clipName}`);
    if (definition.control === "slider") {
      prepareSeatAction(clipName, definition, clip);
      continue;
    }
    const action = mixer.clipAction(clip);
    action.clampWhenFinished = true;
    action.loop = definition.loop ? THREE.LoopRepeat : THREE.LoopOnce;
    action.repetitions = definition.loop ? Infinity : 1;
    mechanicalState.set(clipName, false);
    createButton(mechanicalControls, clipName, (button) => {
      const enabled = !mechanicalState.get(clipName);
      mechanicalState.set(clipName, enabled);
      button.classList.toggle("is-active", enabled);
      if (definition.loop) {
        enabled ? action.reset().play() : action.stop();
      } else {
        action.paused = false;
        action.enabled = true;
        action.setLoop(THREE.LoopOnce, 1);
        action.timeScale = enabled ? 1 : -1;
        action.time = enabled ? 0 : clip.duration;
        action.play();
      }
      activity.textContent = `${labels[clipName]} · ${enabled ? "开启" : "复位"}`;
    });
  }
  mechanicalCount.textContent = `${Object.keys(manifest.animations).length} clips`;
}

function formatSeatValue(definition, value) {
  if (definition.type === "rotate") return `${Math.round(THREE.MathUtils.radToDeg(value))}°`;
  return `${Math.round(value * 100)} cm`;
}

function setSeatValue(clipName, value) {
  const definition = seatDefinitions.get(clipName);
  const binding = seatActions.get(clipName);
  if (!definition || !binding) return;
  const [minimum, maximum] = definition.range;
  const progress = THREE.MathUtils.clamp((value - minimum) / (maximum - minimum), 0, 1);
  binding.action.enabled = true;
  binding.action.paused = true;
  binding.action.time = binding.clip.duration * progress;
  mixer.update(0);
  const output = document.querySelector(`[data-seat-output="${clipName}"]`);
  if (output) output.textContent = formatSeatValue(definition, value);
}

function resetSeatControls(reportActivity = true) {
  for (const input of seatControls.querySelectorAll("input[data-seat-clip]")) {
    const clipName = input.dataset.seatClip;
    const definition = seatDefinitions.get(clipName);
    if (!definition) continue;
    input.value = String(definition.defaultValue);
    setSeatValue(clipName, definition.defaultValue);
  }
  if (reportActivity) activity.textContent = "主驾座椅 · 已复位";
}

function bindSeatControls() {
  for (const input of seatControls.querySelectorAll("input[data-seat-clip]")) {
    const clipName = input.dataset.seatClip;
    const definition = seatDefinitions.get(clipName);
    if (!definition) throw new Error(`座椅滑杆缺少动作 ${clipName}`);
    const [minimum, maximum] = definition.range;
    input.min = String(minimum);
    input.max = String(maximum);
    input.step = "any";
    input.value = String(definition.defaultValue);
    input.disabled = false;
    input.addEventListener("input", () => {
      const value = Number(input.value);
      setSeatValue(clipName, value);
      activity.textContent = `${labels[clipName]} · ${formatSeatValue(definition, value)}`;
    });
  }
  resetSeatControls(false);
  seatReset.disabled = false;
  seatReset.addEventListener("click", () => resetSeatControls(true));
}

function hasSeatAncestor(object, names) {
  for (let current = object; current; current = current.parent) {
    if (names.has(current.name)) return true;
  }
  return false;
}

function fogMaterial(material) {
  if (fogMaterialCache.has(material)) return fogMaterialCache.get(material);
  const fogged = material.clone();
  fogged.name = `seat_focus_fog__${material.name}`;
  if (fogged.color) fogged.color.lerp(new THREE.Color(0x7c8a91), 0.78);
  if (fogged.emissive) fogged.emissive.set(0x000000);
  fogged.emissiveIntensity = 0;
  fogged.metalness = Math.min(fogged.metalness ?? 0, 0.15);
  fogged.roughness = 1;
  fogged.opacity = 0.12;
  fogged.transparent = true;
  fogged.depthWrite = false;
  fogged.needsUpdate = true;
  fogMaterialCache.set(material, fogged);
  return fogged;
}

function materialStaysClear(object, material) {
  const frontSeats = new Set(["driver_seat_track_static", "passenger_seat_static"]);
  if (hasSeatAncestor(object, frontSeats)) return true;
  return material?.name?.startsWith("seat_focus_clear_rear_");
}

function enterSeatFocus() {
  if (!modelRoot || seatFocusActive) return;
  savedCameraState = { position: camera.position.clone(), target: controls.target.clone() };
  modelRoot.traverse((object) => {
    if (!object.isMesh || seatMaterialRestore.has(object)) return;
    seatMaterialRestore.set(object, object.material);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const focused = materials.map((material) => materialStaysClear(object, material) ? material : fogMaterial(material));
    object.material = Array.isArray(object.material) ? focused : focused[0];
  });
  const driver = modelRoot.getObjectByName("driver_seat_height");
  const center = new THREE.Box3().setFromObject(driver).getCenter(new THREE.Vector3());
  startCameraTween(center.clone().add(new THREE.Vector3(1.65, 1.15, -1.65)), center);
  seatFocusActive = true;
  seatFocusToggle.classList.add("is-active");
  seatFocusToggle.textContent = "退出四座聚焦";
  activity.textContent = "座椅模式 · 四座清晰 / 其他部件雾化";
}

function exitSeatFocus() {
  if (!seatFocusActive) return;
  for (const [object, material] of seatMaterialRestore) object.material = material;
  seatMaterialRestore.clear();
  if (savedCameraState) startCameraTween(savedCameraState.position, savedCameraState.target);
  seatFocusActive = false;
  seatFocusToggle.classList.remove("is-active");
  seatFocusToggle.textContent = "进入四座聚焦";
  activity.textContent = "整车模式 · 材质已恢复";
}

function startCameraTween(position, target) {
  cameraTween = {
    started: performance.now(),
    duration: 560,
    fromPosition: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toPosition: position.clone(),
    toTarget: target.clone(),
  };
}

function updateCameraTween() {
  if (!cameraTween) return;
  const linear = THREE.MathUtils.clamp((performance.now() - cameraTween.started) / cameraTween.duration, 0, 1);
  const eased = 1 - Math.pow(1 - linear, 3);
  camera.position.lerpVectors(cameraTween.fromPosition, cameraTween.toPosition, eased);
  controls.target.lerpVectors(cameraTween.fromTarget, cameraTween.toTarget, eased);
  if (linear >= 1) cameraTween = undefined;
}

seatFocusToggle.addEventListener("click", () => seatFocusActive ? exitSeatFocus() : enterSeatFocus());

function lightColor(id) {
  if (id.includes("indicator")) return 0xff5c06;
  if (id === "tail_lights") return 0xff1608;
  return 0xdff6ff;
}

function bindLightControls(root, manifest) {
  const materials = new Map();
  root.traverse((object) => {
    if (!object.isMesh) return;
    for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
      if (material?.name) materials.set(material.name, material);
    }
  });
  for (const [id, definition] of Object.entries(manifest.lights)) {
    const material = materials.get(definition.materialSemantic);
    if (!material) throw new Error(`GLB 缺少灯光材质 ${definition.materialSemantic}`);
    material.emissive = new THREE.Color(lightColor(id));
    material.emissiveIntensity = definition.offEmissive;
    material.toneMapped = false;
    lightState.set(id, false);
    const button = createButton(lightControls, id, (control) => {
      const enabled = !lightState.get(id);
      lightState.set(id, enabled);
      control.classList.toggle("is-active", enabled);
      if (!definition.flashHz) material.emissiveIntensity = enabled ? definition.onEmissive : definition.offEmissive;
      indicatorPhase.set(id, 0);
      activity.textContent = `${labels[id]} · ${enabled ? "开启" : "关闭"}`;
    });
    button.dataset.material = definition.materialSemantic;
    lightState.set(id, false);
    indicatorPhase.set(id, 0);
    definition._material = material;
  }
  lightCount.textContent = `${Object.keys(manifest.lights).length} states`;
}

function updateIndicators(manifest, delta) {
  for (const [id, definition] of Object.entries(manifest.lights)) {
    if (!definition.flashHz || !definition._material) continue;
    if (!lightState.get(id)) {
      definition._material.emissiveIntensity = definition.offEmissive;
      continue;
    }
    const phase = (indicatorPhase.get(id) + delta * definition.flashHz) % 1;
    indicatorPhase.set(id, phase);
    definition._material.emissiveIntensity = phase < 0.5 ? definition.onEmissive : definition.offEmissive;
  }
}

async function loadLab() {
  const started = performance.now();
  const manifest = await fetch("../dist/nio-es7-component-manifest.json").then((response) => {
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    return response.json();
  });
  const gltf = await new GLTFLoader().loadAsync("../dist/nio-es7-animated.glb");
  const elapsed = performance.now() - started;
  prepareModel(gltf.scene);
  scene.add(gltf.scene);
  modelRoot = gltf.scene;
  fitCamera(gltf.scene);
  mixer = new THREE.AnimationMixer(gltf.scene);
  bindMechanicalControls(gltf, manifest);
  bindSeatControls();
  bindLightControls(gltf.scene, manifest);
  setMetrics(manifest, elapsed);
  seatFocusToggle.disabled = false;
  status.textContent = `Stage C 已载入 · ${manifest.statistics.animationClips} 个机械动作`;
  activity.textContent = "整车关闭 / 灯光关闭";
  return manifest;
}

const clock = new THREE.Clock();
let manifest;
function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  mixer?.update(delta);
  if (manifest) updateIndicators(manifest, delta);
  updateCameraTween();
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener("resize", () => {
  renderer.setSize(panel.clientWidth, panel.clientHeight, false);
  camera.aspect = panel.clientWidth / panel.clientHeight;
  camera.updateProjectionMatrix();
});

animate();
loadLab().then((value) => { manifest = value; }).catch((error) => {
  console.error(error);
  status.textContent = "载入失败";
  activity.textContent = error.message;
  document.body.dataset.loadError = error.message;
});
