#!/usr/bin/env python3
"""Build four independently scrubbable ES7 driver-seat animation clips."""

import filecmp
import json
import shutil
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-seat-animations.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
COMPONENT_MARKER = "ES7_SEAT_COMPONENTS"
ANIMATION_MARKER = "ES7_SEAT_ANIMATIONS"
MANAGED_STAGE = "C1"
MANAGED_PREFIX = "es7_seat__"
FPS = 30


def fail(message):
    raise SystemExit(f"ES7 SEAT ANIMATION BUILD FAILED: {message}")


def action_fcurves(action):
    for layer in action.layers:
        for strip in layer.strips:
            for channelbag in strip.channelbags:
                yield from channelbag.fcurves


def remove_managed_track(obj, clip):
    if not obj.animation_data:
        return
    for track in list(obj.animation_data.nla_tracks):
        if track.name != clip:
            continue
        if not all(strip.action and strip.action.get("es7_managed_stage") == MANAGED_STAGE for strip in track.strips):
            fail(f"refusing to replace unmanaged track {clip} on {obj.name}")
        obj.animation_data.nla_tracks.remove(track)


def remove_managed_action(name):
    action = bpy.data.actions.get(name)
    if action is None:
        return
    if action.get("es7_managed_stage") != MANAGED_STAGE:
        fail(f"refusing to replace unmanaged action {name}")
    if action.users:
        fail(f"managed action {name} is still in use")
    bpy.data.actions.remove(action)


def build_action(obj, component_id, spec):
    clip = spec["clip"]
    action_name = f"{MANAGED_PREFIX}{clip}__{component_id}"
    remove_managed_track(obj, clip)
    remove_managed_action(action_name)
    if obj.animation_data and obj.animation_data.action:
        fail(f"{obj.name} has an unexpected active action")

    data_path = "location" if spec["type"] == "translate" else "rotation_euler"
    index = {"X": 0, "Y": 1, "Z": 2}[spec["axis"]]
    obj.rotation_mode = "XYZ"
    base_value = float(getattr(obj, data_path)[index])
    minimum, maximum = (float(value) for value in spec["range"])
    frame_end = max(2, round(float(spec["durationSeconds"]) * FPS) + 1)
    scene = bpy.context.scene
    for frame, value in ((1, base_value + minimum), (frame_end, base_value + maximum)):
        scene.frame_set(frame)
        getattr(obj, data_path)[index] = value
        obj.keyframe_insert(data_path=data_path, index=index, frame=frame, group=component_id)
    if not obj.animation_data or not obj.animation_data.action:
        fail(f"Blender did not create an action for {component_id}")
    action = obj.animation_data.action
    action.name = action_name
    action["es7_managed_stage"] = MANAGED_STAGE
    action["clip"] = clip
    action["component_id"] = component_id
    action["data_path"] = data_path
    action["array_index"] = index
    action["base_value"] = base_value
    action["default_value"] = float(spec["defaultValue"])
    action["range"] = [minimum, maximum]
    action["duration_seconds"] = float(spec["durationSeconds"])
    action["frame_start"] = 1
    action["frame_end"] = frame_end
    for curve in action_fcurves(action):
        for keyframe in curve.keyframe_points:
            keyframe.interpolation = "BEZIER"
            keyframe.easing = "AUTO"

    track = obj.animation_data.nla_tracks.new()
    track.name = clip
    strip = track.strips.new(action_name, 1, action)
    strip.name = clip
    strip.action_frame_start = 1
    strip.action_frame_end = frame_end
    track.mute = True
    obj.animation_data.action = None
    getattr(obj, data_path)[index] = base_value
    obj["seat_control_clip"] = clip
    obj["seat_control_default"] = float(spec["defaultValue"])
    return action_name, frame_end


def preserve_checkpoint():
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if CHECKPOINT_PATH.exists():
        if not filecmp.cmp(MASTER_PATH, CHECKPOINT_PATH, shallow=False):
            fail(f"checkpoint differs from current pre-animation master: {CHECKPOINT_PATH}")
        return
    shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before building seat animations")
    if not bpy.data.objects.get(COMPONENT_MARKER):
        fail("seat component rig is missing")
    if bpy.data.objects.get(ANIMATION_MARKER):
        fail("seat animations have already been applied")
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    components = {component["id"]: component for component in schema["components"]}
    actions = [action for action in schema["mechanicalActions"] if action.get("stage") == "C"]
    if len(actions) != 4:
        fail(f"expected four Stage-C seat actions, found {len(actions)}")
    preserve_checkpoint()
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.render.fps_base = 1.0
    action_names = []
    maximum_frame = 2
    for spec in actions:
        if spec.get("control") != "slider" or len(spec["targets"]) != 1:
            fail(f"seat action must be a single-target slider: {spec['id']}")
        target = spec["targets"][0]
        component_id = target["componentId"]
        if target.get("direction") != 1:
            fail(f"seat slider direction must be positive: {spec['id']}")
        component = components.get(component_id)
        obj = bpy.data.objects.get(component["nodeName"] if component else "")
        if obj is None:
            fail(f"missing target node for {spec['id']}")
        action_name, frame_end = build_action(obj, component_id, spec)
        action_names.append(action_name)
        maximum_frame = max(maximum_frame, frame_end)

    marker = bpy.data.objects.new(ANIMATION_MARKER, None)
    bpy.data.collections["RIG_COMPONENTS"].objects.link(marker)
    marker["status"] = "four-independent-driver-seat-slider-clips"
    marker["stage"] = MANAGED_STAGE
    marker["clip_count"] = len(actions)
    marker["managed_actions"] = action_names
    marker["checkpoint"] = str(CHECKPOINT_PATH.relative_to(LAB_ROOT))
    scene["es7_seat_animation_stage"] = MANAGED_STAGE
    scene.frame_start = 1
    scene.frame_end = max(scene.frame_end, maximum_frame)
    scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))
    print("ES7 SEAT ANIMATION BUILD PASS")
    print(f"- slider clips: {len(actions)}")
    print(f"- frame range: 1-{maximum_frame} at {FPS} fps")
    print(f"- checkpoint: {CHECKPOINT_PATH}")


if __name__ == "__main__":
    main()

