#!/usr/bin/env python3
"""Build schema-driven ES7 Stage-A mechanical clips as mergeable NLA tracks."""

import json
import shutil
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-stage-a-animation.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
STAGE_MARKER = "ES7_STAGE_A3_MECHANICAL_ANIMATIONS"
MANAGED_PREFIX = "es7_stage_a__"
FPS = 30


def fail(message):
    raise SystemExit(f"ES7 STAGE-A ANIMATION BUILD FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def axis_index(axis):
    try:
        return {"X": 0, "Y": 1, "Z": 2}[axis]
    except KeyError:
        fail(f"unsupported axis {axis}")


def action_fcurves(action):
    for layer in action.layers:
        for strip in layer.strips:
            for channelbag in strip.channelbags:
                yield from channelbag.fcurves


def remove_managed_track(obj, clip):
    if not obj.animation_data:
        return
    for track in list(obj.animation_data.nla_tracks):
        if track.name == clip:
            if not all(strip.action and strip.action.get("es7_managed_stage") == "A3.1" for strip in track.strips):
                fail(f"refusing to replace unmanaged NLA track {clip} on {obj.name}")
            obj.animation_data.nla_tracks.remove(track)


def remove_managed_action(name):
    action = bpy.data.actions.get(name)
    if not action:
        return
    if action.get("es7_managed_stage") != "A3.1":
        fail(f"refusing to replace unmanaged action {name}")
    if action.users:
        fail(f"managed action {name} is still in use")
    bpy.data.actions.remove(action)


def key_values(base_value, action_spec):
    frame_end = max(2, round(float(action_spec["durationSeconds"]) * FPS) + 1)
    minimum, maximum = (float(value) for value in action_spec["range"])
    if minimum < 0.0 < maximum:
        return frame_end, (
            (1, base_value),
            (round(1 + (frame_end - 1) * 0.25), base_value + minimum),
            (round(1 + (frame_end - 1) * 0.75), base_value + maximum),
            (frame_end, base_value),
        )
    delta = minimum if abs(minimum) > abs(maximum) else maximum
    return frame_end, ((1, base_value), (frame_end, base_value + delta))


def build_target_action(obj, component_id, action_spec):
    clip = action_spec["clip"]
    action_name = f"{MANAGED_PREFIX}{clip}__{component_id}"
    remove_managed_track(obj, clip)
    if obj.animation_data and obj.animation_data.action:
        active = obj.animation_data.action
        if active.get("es7_managed_stage") == "A3.1":
            obj.animation_data.action = None
        else:
            fail(f"{obj.name} has an unmanaged active action")
    remove_managed_action(action_name)

    data_path = "location" if action_spec["type"] == "translate" else "rotation_euler"
    if action_spec["type"] not in {"translate", "rotate"}:
        fail(f"unsupported action type {action_spec['type']}")
    index = axis_index(action_spec["axis"])
    obj.rotation_mode = "XYZ"
    base_value = float(getattr(obj, data_path)[index])
    frame_end, values = key_values(base_value, action_spec)

    scene = bpy.context.scene
    for frame, value in values:
        scene.frame_set(frame)
        getattr(obj, data_path)[index] = value
        obj.keyframe_insert(data_path=data_path, index=index, frame=frame, group=component_id)
    if not obj.animation_data or not obj.animation_data.action:
        fail(f"Blender did not create an action for {component_id}")
    action = obj.animation_data.action
    action.name = action_name
    action["es7_managed_stage"] = "A3.1"
    action["clip"] = clip
    action["component_id"] = component_id
    action["data_path"] = data_path
    action["array_index"] = index
    action["duration_seconds"] = float(action_spec["durationSeconds"])
    action["frame_start"] = 1
    action["frame_end"] = frame_end
    action["range"] = [float(value) for value in action_spec["range"]]
    action["loop"] = bool(action_spec.get("loop", False))

    for curve in action_fcurves(action):
        for keyframe in curve.keyframe_points:
            if action_spec.get("loop"):
                keyframe.interpolation = "LINEAR"
            else:
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
    obj["stage_a_clip"] = clip
    obj["stage_a_duration_seconds"] = float(action_spec["durationSeconds"])
    return frame_end, action_name


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before building animations")
    schema = load_json(SCHEMA_PATH)
    components = {component["id"]: component for component in schema["components"]}
    stage_a_actions = [action for action in schema["mechanicalActions"] if action.get("stage") is None]
    if not CHECKPOINT_PATH.exists():
        CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)

    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.render.fps_base = 1.0
    maximum_frame = 2
    target_count = 0
    action_names = []
    for action_spec in stage_a_actions:
        for target in action_spec["targets"]:
            component_id = target["componentId"]
            component = components.get(component_id)
            if not component:
                fail(f"missing component {component_id} for {action_spec['id']}")
            obj = bpy.data.objects.get(component["nodeName"])
            if not obj:
                fail(f"missing target node {component['nodeName']}")
            frame_end, action_name = build_target_action(obj, component_id, action_spec)
            maximum_frame = max(maximum_frame, frame_end)
            target_count += 1
            action_names.append(action_name)

    marker = bpy.data.objects.get(STAGE_MARKER)
    if not marker:
        marker = bpy.data.objects.new(STAGE_MARKER, None)
        bpy.data.collections["RIG_COMPONENTS"].objects.link(marker)
    marker["stage"] = "A3.1"
    marker["status"] = "mechanical-actions-built"
    marker["clip_count"] = len(stage_a_actions)
    marker["target_action_count"] = target_count
    marker["managed_actions"] = action_names
    marker["checkpoint"] = str(CHECKPOINT_PATH.relative_to(LAB_ROOT))
    scene["es7_rig_stage"] = "A3.1-mechanical-animations"
    scene["es7_stage_a_clip_count"] = len(stage_a_actions)
    scene.frame_start = 1
    scene.frame_end = maximum_frame
    scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))

    print("ES7 STAGE-A ANIMATION BUILD PASS")
    print(f"- mechanical clips: {len(stage_a_actions)}")
    print(f"- target actions/NLA tracks: {target_count}")
    print(f"- longest frame range: 1-{maximum_frame} at {FPS} fps")
    print(f"- checkpoint: {CHECKPOINT_PATH}")


if __name__ == "__main__":
    main()
