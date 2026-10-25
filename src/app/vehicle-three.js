import * as THREE from "../../vendor/three/three.module.js";
import { OrbitControls } from "../../vendor/three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "../../vendor/three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "../../vendor/three/addons/loaders/DRACOLoader.js";
import { resolvePresentationByScenario } from "../vehicle/hmi-animation-adapter.js";
import { VEHICLE_ASSET_PROFILE, canFallbackToInlineManifest } from "../vehicle/vehicle-asset-profile.js";
import { ES7AnimationRuntime } from "./es7-animation-runtime.js";
import { ES7_ACTION_CATALOG } from "../vehicle/es7-action-catalog.js";

const ES7_ACTION_COUNT = Object.keys(ES7_ACTION_CATALOG).length;

const container = document.querySelector("#vehicle3dStage");
const statusEl = document.querySelector("#modelStatus");
const SEAT_FOCUS_EXIT_DELAY_MS = 1200;
const SEAT_FOCUS_WATCHDOG_MS = 8000;
const SEAT_FOCUS_CLEAR_NODE_NAMES = new Set([
  "driver_seat_track_static",
  "passenger_seat_static",
  "rear_left_seat_static",
  "rear_right_seat_static",
]);
const SEAT_ADJUSTMENT_COMPONENT_IDS = new Set([
  "driverSeatBackrest",
  "driver_seat_fore_aft",
  "driver_seat_height",
  "driver_seat_backrest_recline",
  "driver_seat_headrest_height",
]);

function setVehicleLoadStatus(message, state = "loading") {
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.dataset.state = state;
  }
  window.__vehicleLoadState = state;
}

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
camera.position.set(4.8, 2.5, 6.2);

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
} catch (error) {
  const message = error?.message || "WebGL context unavailable";
  setVehicleLoadStatus(`WebGL 初始化失败，无法展示 NIO ES7 组件动画 GLB：${message}`, "failed");
  window.__vehicleBootError = message;
  window.dispatchEvent(new CustomEvent("vehicleModelLoadFailed", { detail: { message, reason: "webgl" } }));
  throw error;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.userData = {};
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.55, 0);
controls.minDistance = 3.2;
controls.maxDistance = 10;
controls.maxPolarAngle = Math.PI * 0.48;
const USER_CAMERA_HOLD_MS = 5000;
let userCameraHoldUntil = 0;
let seatAdjustmentFocusController = null;
controls.addEventListener("start", () => {
  userCameraHoldUntil = performance.now() + USER_CAMERA_HOLD_MS;
  camera.userData.tween = null;
  seatAdjustmentFocusController?.handleManualCameraInput();
});
controls.addEventListener("end", () => {
  userCameraHoldUntil = performance.now() + USER_CAMERA_HOLD_MS;
});

const vehicleRoot = new THREE.Group();
scene.add(vehicleRoot);

const rig = new THREE.Group();
rig.name = "vehicle_control_rig";
rig.visible = false;
scene.add(rig);

const componentBindings = {};
let modelLoaded = false;
let animationController = null;
let activeVehicleModelSource = "";
let loadedVehicleAnimationClips = [];
let lastRigStatePublishAt = 0;
let es7AssetManifest = null;
let es7AnimationRuntime = null;
const animationClock = new THREE.Clock();

const vehicleModelSources = [...VEHICLE_ASSET_PROFILE.source.modelSources];

const DEFAULT_COMPONENT_MANIFEST = VEHICLE_ASSET_PROFILE.defaultComponentManifest;
let componentManifest = DEFAULT_COMPONENT_MANIFEST;

function hasNamedAncestor(object, names) {
  for (let current = object; current; current = current.parent) {
    if (names.has(current.name)) return true;
  }
  return false;
}

function isSeatAdjustmentPresentation(scenarioOrMode, options = {}) {
  if (scenarioOrMode === "seatControl" || options.visualScenario === "seatControl") return true;
  if (SEAT_ADJUSTMENT_COMPONENT_IDS.has(options.component)) return true;
  if (Number.isFinite(options.statePatch?.driverBackrestAngle)) return true;
  return Object.keys(options.statePatch?.componentActionStateById || {})
    .some((actionId) => SEAT_ADJUSTMENT_COMPONENT_IDS.has(actionId));
}

class SeatAdjustmentFocusController {
  constructor(model) {
    this.model = model;
    this.driverSeat = model.getObjectByName("driver_seat_height")
      || model.getObjectByName("driver_seat_track_static");
    this.missingClearSeatNodes = [...SEAT_FOCUS_CLEAR_NODE_NAMES]
      .filter((nodeName) => !model.getObjectByName(nodeName));
    this.active = false;
    this.cameraWasUserAdjusted = false;
    this.exitTimer = 0;
    this.watchdogTimer = 0;
    this.materialRestore = new Map();
    this.fogMaterialCache = new Map();
    this.foggedMeshCount = 0;
    this.savedCameraState = null;
    this.lastTriggerReason = null;
    this.lastExitReason = null;
  }

  begin({ reason = "seat-adjustment", refocus = false } = {}) {
    if (!this.driverSeat || this.missingClearSeatNodes.length) {
      this.lastExitReason = this.driverSeat
        ? `clear-seat-nodes-missing:${this.missingClearSeatNodes.join(",")}`
        : "driver-seat-node-missing";
      publishRigDebugState(true);
      return false;
    }
    this.clearExitTimer();
    this.clearWatchdogTimer();
    this.lastTriggerReason = reason;
    if (!this.active) {
      this.savedCameraState = {
        position: camera.position.clone(),
        target: controls.target.clone(),
      };
      this.cameraWasUserAdjusted = false;
      this.applyFocusMaterials();
      this.active = true;
      this.focusDriverSeat();
    } else if (refocus) {
      this.focusDriverSeat();
    }
    this.watchdogTimer = window.setTimeout(
      () => this.exit({ reason: "watchdog" }),
      SEAT_FOCUS_WATCHDOG_MS,
    );
    publishRigDebugState(true);
    return true;
  }

  requestExit({ delayMs = SEAT_FOCUS_EXIT_DELAY_MS, reason = "completed" } = {}) {
    if (!this.active) return false;
    this.clearExitTimer();
    if (delayMs <= 0) return this.exit({ reason });
    this.exitTimer = window.setTimeout(() => this.exit({ reason }), delayMs);
    publishRigDebugState(true);
    return true;
  }

  exit({ reason = "completed", restoreCamera = true } = {}) {
    if (!this.active) return false;
    this.clearExitTimer();
    this.clearWatchdogTimer();
    for (const [object, material] of this.materialRestore) object.material = material;
    this.materialRestore.clear();
    this.foggedMeshCount = 0;
    const savedCameraState = this.savedCameraState;
    const shouldRestoreCamera = restoreCamera
      && !this.cameraWasUserAdjusted
      && savedCameraState;
    this.savedCameraState = null;
    this.active = false;
    this.lastExitReason = reason;
    if (shouldRestoreCamera) {
      animateCameraToVectors(savedCameraState.position, savedCameraState.target);
    }
    publishRigDebugState(true);
    return true;
  }

  handleManualCameraInput() {
    if (!this.active) return;
    this.cameraWasUserAdjusted = true;
    camera.userData.tween = null;
    publishRigDebugState(true);
  }

  applyFocusMaterials() {
    this.model.traverse((object) => {
      if (!object.isMesh || this.materialRestore.has(object) || !object.material) return;
      const original = object.material;
      const materials = Array.isArray(original) ? original : [original];
      const focused = materials.map((material) => (
        this.materialStaysClear(object, material) ? material : this.fogMaterial(material)
      ));
      this.materialRestore.set(object, original);
      object.material = Array.isArray(original) ? focused : focused[0];
      if (focused.some((material, index) => material !== materials[index])) this.foggedMeshCount += 1;
    });
  }

  materialStaysClear(object, material) {
    if (hasNamedAncestor(object, SEAT_FOCUS_CLEAR_NODE_NAMES)) return true;
    return material?.name?.startsWith("seat_focus_clear_rear_") === true;
  }

  fogMaterial(material) {
    if (!material?.clone) return material;
    if (this.fogMaterialCache.has(material)) return this.fogMaterialCache.get(material);
    const fogged = material.clone();
    fogged.name = `seat_focus_fog__${material.name || "unnamed"}`;
    if (fogged.color) fogged.color.lerp(new THREE.Color(0x7c8a91), 0.78);
    if (fogged.emissive) fogged.emissive.set(0x000000);
    if ("emissiveIntensity" in fogged) fogged.emissiveIntensity = 0;
    if (Number.isFinite(fogged.metalness)) fogged.metalness = Math.min(fogged.metalness, 0.15);
    if (Number.isFinite(fogged.roughness)) fogged.roughness = 1;
    fogged.opacity = 0.12;
    fogged.transparent = true;
    fogged.depthWrite = false;
    fogged.needsUpdate = true;
    this.fogMaterialCache.set(material, fogged);
    return fogged;
  }

  focusDriverSeat() {
    this.model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.driverSeat);
    if (bounds.isEmpty()) return false;
    const center = bounds.getCenter(new THREE.Vector3());
    const modelRotation = this.model.getWorldQuaternion(new THREE.Quaternion());
    const offset = new THREE.Vector3(1.65, 1.15, -1.65)
      .applyQuaternion(modelRotation)
      .normalize()
      .multiplyScalar(3.25);
    return animateCameraToVectors(center.clone().add(offset), center);
  }

  clearExitTimer() {
    if (this.exitTimer) window.clearTimeout(this.exitTimer);
    this.exitTimer = 0;
  }

  clearWatchdogTimer() {
    if (this.watchdogTimer) window.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = 0;
  }

  getState() {
    return {
      ready: Boolean(this.driverSeat) && this.missingClearSeatNodes.length === 0,
      active: this.active,
      exitScheduled: Boolean(this.exitTimer),
      watchdogActive: Boolean(this.watchdogTimer),
      materialCacheSize: this.fogMaterialCache.size,
      foggedMeshCount: this.foggedMeshCount,
      cameraWasUserAdjusted: this.cameraWasUserAdjusted,
      clearSeatNodeCount: SEAT_FOCUS_CLEAR_NODE_NAMES.size - this.missingClearSeatNodes.length,
      missingClearSeatNodes: [...this.missingClearSeatNodes],
      lastTriggerReason: this.lastTriggerReason,
      lastExitReason: this.lastExitReason,
    };
  }

  dispose() {
    if (this.active) this.exit({ reason: "dispose", restoreCamera: false });
    this.clearExitTimer();
    this.clearWatchdogTimer();
    for (const fogged of this.fogMaterialCache.values()) fogged?.dispose?.();
    this.fogMaterialCache.clear();
  }
}

class VehicleAnimationController {
  constructor() {
    this.state = {
      scenario: "idle",
      mode: "idle",
      component: "body",
      route: 0,
      safety: 0,
      offline: 0,
    };
    this.targets = { ...this.state };
    this.effects = this.createEffects();
  }

  createEffects() {
    const route = new THREE.Group();
    route.name = "scenario_route_light_path";
    route.visible = false;
    const routeMat = new THREE.MeshBasicMaterial({
      color: 0x7dffc8,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
    });
    const routeCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.3, 0.04, -0.28),
      new THREE.Vector3(1.4, 0.05, -0.2),
      new THREE.Vector3(2.25, 0.06, 0.2),
      new THREE.Vector3(2.85, 0.07, 0.7),
    ]);
    route.add(new THREE.Mesh(new THREE.TubeGeometry(routeCurve, 48, 0.018, 8, false), routeMat));
    rig.add(route);

    const shieldMat = new THREE.MeshBasicMaterial({
      color: 0xffb15e,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const shield = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.012, 12, 128), shieldMat);
    shield.name = "scenario_safety_shield";
    shield.rotation.x = Math.PI / 2;
    shield.position.set(0, 0.58, 0);
    shield.visible = false;
    rig.add(shield);

    const edgeGlowMat = new THREE.MeshBasicMaterial({
      color: 0x9be7ff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const edgeGlow = new THREE.Mesh(new THREE.RingGeometry(1.58, 1.64, 128), edgeGlowMat);
    edgeGlow.name = "scenario_offline_edge_glow";
    edgeGlow.rotation.x = -Math.PI / 2;
    edgeGlow.position.y = 0.015;
    edgeGlow.visible = false;
    rig.add(edgeGlow);

    return { route, routeMat, shield, shieldMat, edgeGlow, edgeGlowMat };
  }

  play(scenarioOrMode, options = {}) {
    if (!modelLoaded) return;
    const scenario = scenarioOrMode || "idle";
    const mode = options.mode || scenario;
    this.state.scenario = scenario;
    this.state.mode = mode;

    const target = {
      route: 0,
      safety: 0,
      offline: 0,
    };

    if (["trip", "planning", "completed"].includes(scenario) || mode === "planning") target.route = 1;
    if (["safety", "blocked"].includes(scenario) || mode === "safety" || mode === "blocked") target.safety = 1;
    if (scenario === "offline" || mode === "offline") target.offline = 1;

    Object.assign(this.targets, target);

    const scenarioLocked = ["windowControl", "trunkControl", "seatControl", "safety", "blocked"].includes(scenario);
    const legacyModeComponent = {
      trip: "body",
      family: "cabin",
      offline: "body",
    };
    const component = options.component
      || (scenarioLocked ? resolvePresentationByScenario(scenario)?.defaultComponent : resolvePresentationByScenario(mode)?.defaultComponent)
      || resolvePresentationByScenario(scenario)?.defaultComponent
      || legacyModeComponent[mode]
      || legacyModeComponent[scenario]
      || "body";
    this.state.component = component;
    focusComponent(component);
  }

  update() {
    const lerp = (current, target, speed = 0.075) => THREE.MathUtils.lerp(current, target, speed);
    this.state.route = lerp(this.state.route, this.targets.route);
    this.state.safety = lerp(this.state.safety, this.targets.safety);
    this.state.offline = lerp(this.state.offline, this.targets.offline);

    const t = performance.now() * 0.001;
    const pulse = 0.5 + Math.sin(t * 3.2) * 0.5;

    this.effects.route.visible = this.state.route > 0.02;
    this.effects.routeMat.opacity = this.state.route * (0.34 + pulse * 0.36);
    this.effects.route.position.y = Math.sin(t * 2) * 0.01;

    this.effects.shield.visible = this.state.safety > 0.02;
    this.effects.shieldMat.opacity = this.state.safety * (0.12 + pulse * 0.22);
    const shieldScale = 1 + this.state.safety * (0.03 + pulse * 0.03);
    this.effects.shield.scale.setScalar(shieldScale);

    this.effects.edgeGlow.visible = this.state.offline > 0.02;
    this.effects.edgeGlowMat.opacity = this.state.offline * (0.18 + pulse * 0.18);
    this.effects.edgeGlow.rotation.z += this.state.offline * 0.006;
  }
}

setupLighting();
const displayStage = setupVehicleDisplayStage();
animationController = new VehicleAnimationController();
initializeVehicleStage();

window.addEventListener("resize", resize);

window.vehicleRig = {
  syncConfirmedState(snapshot, options = {}) {
    if (!modelLoaded || !snapshot?.id) return false;
    return es7AnimationRuntime?.setConfirmedSnapshot(snapshot, {
      immediate: options.immediate !== false,
    }) === true;
  },
  beginSeatAdjustmentFocus(options = {}) {
    return seatAdjustmentFocusController?.begin(options) === true;
  },
  endSeatAdjustmentFocus(options = {}) {
    return seatAdjustmentFocusController?.requestExit(options) === true;
  },
  playScenarioAnimation(scenarioOrMode, options = {}) {
    if (!modelLoaded) return false;
    const seatAdjustment = isSeatAdjustmentPresentation(scenarioOrMode, options);
    if (!seatAdjustment) {
      seatAdjustmentFocusController?.requestExit({ delayMs: 0, reason: "non-seat-presentation" });
    }
    if (options.commandId && options.statePatch) {
      es7AnimationRuntime?.setConfirmedSnapshot({
        id: options.commandId,
        values: options.statePatch,
      });
    }
    animationController.play(scenarioOrMode, options);
    if (seatAdjustment) {
      seatAdjustmentFocusController?.begin({
        reason: "confirmed-seat-presentation",
        refocus: true,
      });
      seatAdjustmentFocusController?.requestExit({
        delayMs: SEAT_FOCUS_EXIT_DELAY_MS,
        reason: "provider-confirmed",
      });
    }
    return true;
  },
  getState() {
    return {
      scenario: animationController?.state.scenario || "idle",
      mode: animationController?.state.mode || "idle",
      routePulse: Number((animationController?.state.route || 0).toFixed(2)),
      safetyPulse: Number((animationController?.state.safety || 0).toFixed(2)),
      offlinePulse: Number((animationController?.state.offline || 0).toFixed(2)),
      componentBindings: Object.keys(componentBindings),
      manifestActionState: getManifestActionState(),
      missingOriginalComponents: getMissingRequiredComponents(),
      activeVehicleModelSource,
      loadedVehicleAnimationClips,
      es7AnimationRuntime: es7AnimationRuntime?.getState() || null,
      displayStage: getDisplayStageState(),
      seatAdjustmentFocus: seatAdjustmentFocusController?.getState() || {
        ready: false,
        active: false,
      },
      modelLoaded,
    };
  },
  getCapabilities() {
    const missingOriginalComponents = getMissingRequiredComponents();
    return {
      originalMovableWindow: Boolean(componentBindings.frontLeftWindow),
      originalMovableTailgate: Boolean(componentBindings.tailgate),
      originalMovableSeatBack: Boolean(componentBindings.driverSeatBackrest),
      modelLoaded,
      componentManifest: getComponentManifestStatus(),
      manifestBindings: Object.keys(componentBindings),
      manifestActionState: getManifestActionState(),
      assetProfile: VEHICLE_ASSET_PROFILE,
      simulatedFeedbackCapabilities: [
        "camera_focus",
        "route_light_path",
        "safety_shield",
        "offline_edge_glow",
      ],
      missingOriginalComponents,
      originalGlbMeshes: {
        source: activeVehicleModelSource || "pending",
        animationClips: loadedVehicleAnimationClips,
        boundOriginalMeshes: [...new Set(Object.values(componentBindings)
          .map((binding) => binding.node.name)
          .filter(Boolean))],
        movableOriginalComponents: {
          frontLeftWindow: Boolean(componentBindings.frontLeftWindow),
          tailgate: Boolean(componentBindings.tailgate),
          driverSeatBackrest: Boolean(componentBindings.driverSeatBackrest),
        },
      },
      mechanicalAnimationSource: "nio-es7-glb-clips",
      displayStage: "dark-static-pedestal",
      seatAdjustmentFocus: seatAdjustmentFocusController?.getState().ready === true
        ? "four-seat-material-fog"
        : "unavailable",
      reason: missingOriginalComponents.length
        ? "当前 NIO ES7 GLB 缺少必需稳定节点，车辆动效已 fail closed。"
        : `当前 NIO ES7 GLB 已绑定稳定组件节点，并通过 ${ES7_ACTION_COUNT} 条机械 clip 的运行时校验。`,
    };
  },
};

window.dispatchEvent(new CustomEvent("vehicleRigReady"));

function setupLighting() {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a2228, 1.7));

  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(4, 6, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x9be7ff, 1.8);
  rim.position.set(-4, 2.8, -4);
  scene.add(rim);

  const soft = new THREE.PointLight(0xffffff, 1.2, 8);
  soft.position.set(0, 2.8, 2.2);
  scene.add(soft);
}

function setupVehicleDisplayStage() {
  const stage = new THREE.Group();
  stage.name = "vehicle_display_stage";
  stage.userData.variant = "dark-static-pedestal";
  stage.userData.topOffset = 0.08;

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(2.05, 2.15, 0.12, 96),
    new THREE.MeshStandardMaterial({
      color: 0x030507,
      roughness: 0.92,
      metalness: 0.05,
    }),
  );
  base.name = "vehicle_display_stage_base";
  base.receiveShadow = true;
  stage.add(base);

  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(2.05, 2.05, 0.02, 96),
    new THREE.MeshStandardMaterial({
      color: 0x080d12,
      roughness: 0.88,
      metalness: 0.08,
    }),
  );
  top.name = "vehicle_display_stage_top";
  top.position.y = 0.07;
  top.receiveShadow = true;
  stage.add(top);

  stage.position.y = -0.7;
  scene.add(stage);
  return stage;
}

function alignDisplayStageToVehicle(model) {
  const bounds = new THREE.Box3().setFromObject(model);
  displayStage.position.y = bounds.min.y - displayStage.userData.topOffset - 0.015;
}

function getDisplayStageState() {
  return {
    present: Boolean(displayStage?.parent),
    variant: displayStage?.userData.variant || null,
    y: Number((displayStage?.position.y || 0).toFixed(3)),
  };
}

async function initializeVehicleStage() {
  try {
    await loadComponentManifest();
  } catch (error) {
    const message = `VehicleAssetProfile 禁止 manifest fallback：${error?.message || "unknown manifest load error"}`;
    setVehicleLoadStatus(message, "failed");
    window.dispatchEvent(new CustomEvent("vehicleModelLoadFailed", { detail: { message, reason: "manifest" } }));
    return;
  }
  loadBaseVehicle();
  resize();
  animate();
}

async function loadComponentManifest() {
  try {
    const response = await fetch(VEHICLE_ASSET_PROFILE.source.componentManifestPath, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    if (manifest.contract !== "nio-es7-component-manifest@1.2.0"
      || !manifest.components || !manifest.animations
      || Object.keys(manifest.animations).length !== ES7_ACTION_COUNT) {
      throw new Error("invalid NIO ES7 runtime manifest");
    }
    es7AssetManifest = manifest;
    componentManifest = DEFAULT_COMPONENT_MANIFEST;
    validateComponentManifest(componentManifest);
    window.__vehicleComponentManifest = {
      source: VEHICLE_ASSET_PROFILE.source.componentManifestPath.replace("./", ""),
      version: manifest.assetVersion,
      contract: manifest.contract,
      animationCount: Object.keys(manifest.animations).length,
      provenance: manifest.provenance,
      components: componentManifest,
      assetProfileId: VEHICLE_ASSET_PROFILE.id,
      fallbackAllowed: false,
    };
  } catch (error) {
    if (!canFallbackToInlineManifest(VEHICLE_ASSET_PROFILE)) {
      componentManifest = {};
      window.__vehicleComponentManifest = {
        source: "manifest-load-failed",
        reason: error?.message || "unknown manifest load error",
        components: componentManifest,
        assetProfileId: VEHICLE_ASSET_PROFILE.id,
        fallbackAllowed: false,
        failClosed: true,
      };
      throw error;
    }
    componentManifest = DEFAULT_COMPONENT_MANIFEST;
    window.__vehicleComponentManifest = {
      source: "default-inline-manifest",
      reason: error?.message || "unknown manifest load error",
      components: componentManifest,
      assetProfileId: VEHICLE_ASSET_PROFILE.id,
      fallbackAllowed: true,
      fallbackMode: VEHICLE_ASSET_PROFILE.manifestPolicy.fallbackMode,
    };
  }
}

function validateComponentManifest(manifest) {
  Object.entries(manifest).forEach(([componentId, spec]) => {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error(`invalid component manifest entry: ${componentId}`);
    }
    if (!Array.isArray(spec.aliases) || !spec.aliases.some((alias) => typeof alias === "string" && alias.trim())) {
      throw new Error(`invalid component aliases: ${componentId}`);
    }
  });
}

function loadBaseVehicle() {
  const loader = new GLTFLoader();
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("../../vendor/three/addons/libs/draco/");
  loader.setDRACOLoader(dracoLoader);
  let loadTimedOut = false;
  let loadSettled = false;
  setVehicleLoadStatus("Three.js 车辆数字孪生加载中，正在请求分组件 GLB 车模", "loading");
  const loadingTimer = window.setTimeout(() => {
    if (!modelLoaded && !loadSettled) {
      loadTimedOut = true;
      const message = "GLB 车模加载超时，未能在 15 秒内显示 NIO ES7";
      setVehicleLoadStatus(`${message}；请确认 WebGL 可用、模型文件可访问后刷新页面`, "timeout");
      window.dispatchEvent(new CustomEvent("vehicleModelLoadFailed", { detail: { message, reason: "timeout" } }));
    }
  }, 15000);

  const loadVehicleSource = (sourceIndex) => {
    const source = vehicleModelSources[sourceIndex];
    loader.load(
      source,
      (gltf) => {
        try {
          window.clearTimeout(loadingTimer);
          loadSettled = true;
          activeVehicleModelSource = source.replace("./", "");
          loadedVehicleAnimationClips = (gltf.animations || []).map((clip) => clip.name || "unnamed");
          const model = gltf.scene;
          model.name = "base_real_vehicle_glb";
          normalizeModel(model);
          alignDisplayStageToVehicle(model);
          vehicleRoot.add(model);
          bindComponentManifest(model);
          const missingRequiredComponents = getMissingRequiredComponents();
          if (missingRequiredComponents.length) {
            throw new Error(`ES7 required component bindings missing: ${missingRequiredComponents.join(", ")}`);
          }
          es7AnimationRuntime = new ES7AnimationRuntime({
            model,
            clips: gltf.animations || [],
            manifest: es7AssetManifest,
          });
          seatAdjustmentFocusController?.dispose();
          seatAdjustmentFocusController = new SeatAdjustmentFocusController(model);
          modelLoaded = true;
          publishRigDebugState(true);
          rig.visible = true;
          setVehicleLoadStatus(
            loadTimedOut
              ? `NIO ES7 已在超时后加载完成：${activeVehicleModelSource}`
              : `NIO ES7 已加载 · ${ES7_ACTION_COUNT} 个机械动作`,
            "loaded",
          );
          window.dispatchEvent(new CustomEvent("vehicleModelLoaded", {
            detail: { recoveredFromTimeout: loadTimedOut, source: activeVehicleModelSource },
          }));
        } catch (error) {
          vehicleRoot.remove(model);
          modelLoaded = false;
          seatAdjustmentFocusController?.dispose();
          seatAdjustmentFocusController = null;
          es7AnimationRuntime?.dispose();
          es7AnimationRuntime = null;
          activeVehicleModelSource = "";
          loadedVehicleAnimationClips = [];
          rig.visible = false;
          setVehicleLoadStatus(`NIO ES7 动画契约校验失败：${error?.message || "unknown error"}`, "failed");
          window.dispatchEvent(new CustomEvent("vehicleModelLoadFailed", { detail: { message: error?.message || "", reason: "animation-contract" } }));
        }
      },
      undefined,
      (error) => {
        if (sourceIndex < vehicleModelSources.length - 1) {
          loadVehicleSource(sourceIndex + 1);
          return;
        }
        window.clearTimeout(loadingTimer);
        loadSettled = true;
        const detail = error?.message ? `：${error.message}` : "";
        setVehicleLoadStatus(`NIO ES7 GLB 加载失败，无法显示车辆可视化${detail}`, "failed");
        modelLoaded = false;
        seatAdjustmentFocusController?.dispose();
        seatAdjustmentFocusController = null;
        loadedVehicleAnimationClips = [];
        rig.visible = false;
        window.dispatchEvent(new CustomEvent("vehicleModelLoadFailed", { detail: { message: error?.message || "", reason: "glb" } }));
      },
    );
  };

  loadVehicleSource(0);
}

function normalizeModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const scale = 3.4 / Math.max(size.x, size.y, size.z);
  model.scale.setScalar(scale);
  model.position.sub(center.multiplyScalar(scale));
  model.rotation.y = Math.PI;
  model.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    if (node.material) {
      node.material.envMapIntensity = 0.85;
    }
  });
}

function normalizeComponentName(name = "") {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function bindComponentManifest(model) {
  Object.keys(componentBindings).forEach((key) => {
    delete componentBindings[key];
  });

  const nodes = [];
  model.traverse((node) => {
    if (node.name) nodes.push(node);
  });

  Object.entries(componentManifest).forEach(([componentId, spec]) => {
    const aliases = new Set((spec.aliases || []).map(normalizeComponentName));
    const match = nodes.find((node) => aliases.has(normalizeComponentName(node.name)));
    if (!match) return;

    componentBindings[componentId] = {
      id: componentId,
      node: match,
    };
  });
}

function getComponentManifestStatus() {
  return Object.fromEntries(
    Object.entries(componentManifest).map(([componentId, spec]) => [
      componentId,
      {
        bound: Boolean(componentBindings[componentId]),
        required: Boolean(spec.required),
        aliases: spec.aliases,
        feedback: spec.feedback || "es7_glb_clip",
      },
    ]),
  );
}

function getMissingRequiredComponents() {
  return Object.entries(componentManifest)
    .filter(([, spec]) => spec.required)
    .map(([componentId]) => componentId)
    .filter((componentId) => !componentBindings[componentId]);
}

function getManifestActionState() {
  const progressByActionId = es7AnimationRuntime?.getState().progressByActionId || {};
  const clipByComponent = {
    frontLeftWindow: "front_left_window_open",
    frontRightWindow: "front_right_window_open",
    tailgate: "tailgate_open",
    driverSeatBackrest: "driver_seat_backrest_recline",
  };
  return Object.fromEntries(
    Object.entries(componentBindings).map(([componentId, binding]) => [
      componentId,
      {
        nodeName: binding.node.name || "",
        clip: clipByComponent[componentId] || null,
        progress: progressByActionId[clipByComponent[componentId]] ?? null,
      },
    ]),
  );
}

function getRigDebugState() {
  return {
    activeVehicleModelSource,
    loadedVehicleAnimationClips,
    modelLoaded,
    mechanicalAnimationSource: "nio-es7-glb-clips",
    manifestBindings: Object.keys(componentBindings),
    missingOriginalComponents: getMissingRequiredComponents(),
    manifestActionState: getManifestActionState(),
    displayStage: getDisplayStageState(),
    seatAdjustmentFocus: seatAdjustmentFocusController?.getState() || {
      ready: false,
      active: false,
    },
  };
}

function publishRigDebugState(force = false) {
  const now = performance.now();
  if (!force && now - lastRigStatePublishAt < 250) return;
  lastRigStatePublishAt = now;
  document.documentElement.dataset.vehicleRigState = JSON.stringify(getRigDebugState());
}

function focusComponent(component) {
  if (!modelLoaded) return;
  const canonicalComponent = {
    frontLeftWindow: "cabin",
    frontRightWindow: "cabin",
    tailgate: "body",
    driverSeatBackrest: "cabin",
    energy: "body",
    battery: "body",
    sensors: "body",
    vehicleComponent: "body",
  }[component] || component;
  const actionComponent = /seat|headrest/.test(component)
    ? "cabin"
    : /wheel/.test(component) ? "wheels" : canonicalComponent;
  const presets = {
    body: { position: [4.8, 2.5, 6.2], target: [0, 0.55, 0] },
    cabin: { position: [2.5, 1.85, 3.7], target: [-0.18, 0.78, 0.05] },
    wheels: { position: [2.6, 1.1, 3.8], target: [0.72, 0.28, 0] },
    chassis: { position: [3.6, 1.05, 4.2], target: [0, 0.12, 0] },
  };
  const preset = presets[actionComponent] || presets.body;
  animateCameraTo(preset.position, preset.target);
}

function animateCameraTo(positionArray, targetArray) {
  return animateCameraToVectors(
    new THREE.Vector3(...positionArray),
    new THREE.Vector3(...targetArray),
  );
}

function animateCameraToVectors(position, target, { durationMs = 560 } = {}) {
  if (performance.now() < userCameraHoldUntil) return false;
  camera.userData.tween = {
    startedAt: performance.now(),
    durationMs,
    fromPosition: camera.position.clone(),
    toPosition: position.clone(),
    fromTarget: controls.target.clone(),
    toTarget: target.clone(),
  };
  return true;
}

function updateCameraTween() {
  const tween = camera.userData.tween;
  if (!tween) return;
  const t = Math.min(1, (performance.now() - tween.startedAt) / tween.durationMs);
  const ease = 1 - Math.pow(1 - t, 3);
  camera.position.lerpVectors(tween.fromPosition, tween.toPosition, ease);
  controls.target.lerpVectors(tween.fromTarget, tween.toTarget, ease);
  if (t >= 1) {
    camera.userData.tween = null;
  }
}

function resize() {
  const rect = container.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  es7AnimationRuntime?.update(Math.min(animationClock.getDelta(), 0.1));
  publishRigDebugState();
  animationController?.update();
  updateCameraTween();
  controls.update();
  renderer.render(scene, camera);
}
