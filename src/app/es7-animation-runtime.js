import * as THREE from "../../vendor/three/three.module.js";
import { SAFETY_BASELINE } from "../runtime/agent-schemas.js";
import {
  ES7_ACTION_CATALOG,
  es7ActionProgress,
} from "../vehicle/es7-action-catalog.js";

const WINDOW_CLIP_BY_ZONE = Object.freeze({
  front_left: "front_left_window_open",
  front_right: "front_right_window_open",
  rear_left: "rear_left_window_open",
  rear_right: "rear_right_window_open",
});

export class ES7AnimationRuntime {
  constructor({ model, clips, manifest }) {
    if (!model?.isObject3D) throw new TypeError("ES7 animation runtime requires a model root");
    if (!Array.isArray(clips)) throw new TypeError("ES7 animation runtime requires GLB clips");
    if (!manifest?.animations || typeof manifest.animations !== "object") {
      throw new TypeError("ES7 animation runtime requires manifest.animations");
    }

    this.mixer = new THREE.AnimationMixer(model);
    this.bindings = new Map();
    this.targets = new Map();
    this.lastSnapshotId = null;

    const clipsByName = new Map(clips.map((clip) => [clip.name, clip]));
    const catalogIds = Object.keys(ES7_ACTION_CATALOG);
    const manifestIds = Object.keys(manifest.animations);
    if (manifestIds.length !== catalogIds.length) {
      throw new Error(`ES7 mechanical action count mismatch: catalog=${catalogIds.length}, manifest=${manifestIds.length}`);
    }

    for (const actionId of catalogIds) {
      const clip = clipsByName.get(actionId);
      const manifestAction = manifest.animations[actionId];
      if (!clip || !manifestAction) throw new Error(`ES7 clip missing: ${actionId}`);
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      action.clampWhenFinished = true;
      action.setLoop(THREE.LoopOnce, 1);
      action.paused = true;
      action.play();
      const definition = ES7_ACTION_CATALOG[actionId];
      const progress = definition.unit === "binary"
        ? definition.defaultValue
        : es7ActionProgress(actionId, definition.defaultValue);
      action.time = clip.duration * progress;
      this.bindings.set(actionId, { action, clip, definition });
      this.targets.set(actionId, progress);
    }
    this.mixer.update(0);
  }

  setConfirmedSnapshot(snapshot, { immediate = false } = {}) {
    if (!snapshot?.id || snapshot.id === this.lastSnapshotId) return false;
    this.lastSnapshotId = snapshot.id;
    const values = snapshot.values || {};

    for (const [zone, percent] of Object.entries(values.windowPositionPercentByZone || {})) {
      const actionId = WINDOW_CLIP_BY_ZONE[zone];
      if (actionId && Number.isFinite(percent)) this.setTarget(actionId, percent / 100, immediate);
    }
    if (typeof values.tailgateOpen === "boolean") {
      this.setTarget("tailgate_open", values.tailgateOpen ? 1 : 0, immediate);
    }
    if (Number.isFinite(values.driverBackrestAngle)) {
      const relativeDegrees = THREE.MathUtils.clamp(
        SAFETY_BASELINE.seat.defaultAngle - values.driverBackrestAngle,
        ES7_ACTION_CATALOG.driver_seat_backrest_recline.minimum,
        ES7_ACTION_CATALOG.driver_seat_backrest_recline.maximum,
      );
      this.setTarget(
        "driver_seat_backrest_recline",
        es7ActionProgress("driver_seat_backrest_recline", relativeDegrees),
        immediate,
      );
    }
    for (const [actionId, value] of Object.entries(values.componentActionStateById || {})) {
      const progress = es7ActionProgress(actionId, value);
      if (progress !== null) this.setTarget(actionId, progress, immediate);
    }
    this.mixer.update(0);
    return true;
  }

  setTarget(actionId, progress, immediate) {
    const binding = this.bindings.get(actionId);
    if (!binding || !Number.isFinite(progress)) return;
    const target = THREE.MathUtils.clamp(progress, 0, 1);
    this.targets.set(actionId, target);
    if (immediate) binding.action.time = binding.clip.duration * target;
  }

  update(deltaSeconds) {
    const delta = Math.max(0, Number(deltaSeconds) || 0);
    for (const [actionId, binding] of this.bindings) {
      const target = this.targets.get(actionId) ?? 0;
      const { action, clip, definition } = binding;
      if (definition.loop) {
        if (target > 0) {
          action.paused = false;
          action.enabled = true;
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.timeScale = 1;
          action.play();
        } else {
          action.paused = true;
          action.time = 0;
        }
        continue;
      }

      action.paused = true;
      action.setLoop(THREE.LoopOnce, 1);
      const current = clip.duration > 0 ? action.time / clip.duration : target;
      if (Math.abs(current - target) < 0.0001) {
        action.time = clip.duration * target;
        continue;
      }
      const step = delta / Math.max(clip.duration, 0.001);
      const next = Math.abs(target - current) <= step
        ? target
        : current + Math.sign(target - current) * step;
      action.time = clip.duration * next;
    }
    this.mixer.update(delta);
  }

  getState() {
    return {
      ready: this.bindings.size === Object.keys(ES7_ACTION_CATALOG).length,
      clipCount: this.bindings.size,
      lastSnapshotId: this.lastSnapshotId,
      progressByActionId: Object.fromEntries([...this.bindings].map(([id, { action, clip }]) => [
        id,
        clip.duration > 0 ? Number((action.time / clip.duration).toFixed(4)) : 0,
      ])),
    };
  }

  dispose() {
    this.mixer.stopAllAction();
    this.bindings.clear();
    this.targets.clear();
  }
}
