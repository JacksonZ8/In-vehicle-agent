#!/usr/bin/env python3
"""Build a Stage-B review sequence without replacing the formal component clips."""

import json
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import WIPER_REVIEW_FRAME_END, WIPER_REVIEW_FRAME_START


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
STAGE_MARKER = "ES7_STAGE_B2_SHOWCASE"
SHOWCASE_TRACK = "stage_b_showcase"
SHOWCASE_PREFIX = "es7_stage_b_showcase__"
MANAGED_STAGE = "B2.2-showcase"
FPS = 30
TIMELINE = {
    "charge-port": (501, 550),
    "mirrors": (551, 600),
    "wipers": (WIPER_REVIEW_FRAME_START, WIPER_REVIEW_FRAME_END),
    "suspension": (671, 740),
}


def fail(message):
    raise SystemExit(f"ES7 STAGE-B SHOWCASE BUILD FAILED: {message}")


def action_fcurves(action):
    for layer in action.layers:
        for strip in layer.strips:
            for channelbag in strip.channelbags:
                yield from channelbag.fcurves


def segment_for_action(action_id):
    if action_id == "charge_port_open":
        return TIMELINE["charge-port"]
    if action_id.startswith("mirror_"):
        return TIMELINE["mirrors"]
    if action_id == "wipers_sweep":
        return TIMELINE["wipers"]
    if action_id == "suspension_raise":
        return TIMELINE["suspension"]
    fail(f"no Stage-B showcase segment for {action_id}")


def remove_managed_track(obj):
    if not obj.animation_data:
        return
    for track in list(obj.animation_data.nla_tracks):
        if track.name != SHOWCASE_TRACK:
            continue
        if not all(strip.action and strip.action.get("es7_managed_stage") == MANAGED_STAGE for strip in track.strips):
            fail(f"refusing to replace unmanaged {SHOWCASE_TRACK} on {obj.name}")
        obj.animation_data.nla_tracks.remove(track)


def remove_managed_action(name):
    action = bpy.data.actions.get(name)
    if not action:
        return
    if action.get("es7_managed_stage") != MANAGED_STAGE or action.users:
        fail(f"refusing to replace action {name}")
    bpy.data.actions.remove(action)


def showcase_values(base, action_spec, direction, frame_start, frame_end):
    delta = max(abs(float(value)) for value in action_spec["range"]) * int(direction)
    midpoint = round((frame_start + frame_end) * 0.5)
    return ((frame_start, base), (midpoint, base + delta), (frame_end, base))


def build_target(obj, component_id, action_spec, direction):
    action_name = SHOWCASE_PREFIX + component_id
    remove_managed_track(obj)
    if obj.animation_data and obj.animation_data.action:
        fail(f"{obj.name} has an unexpected active action")
    remove_managed_action(action_name)
    data_path = "location" if action_spec["type"] == "translate" else "rotation_euler"
    index = {"X": 0, "Y": 1, "Z": 2}[action_spec["axis"]]
    base = float(getattr(obj, data_path)[index])
    frame_start, frame_end = segment_for_action(action_spec["id"])
    for frame, value in showcase_values(base, action_spec, direction, frame_start, frame_end):
        bpy.context.scene.frame_set(frame)
        getattr(obj, data_path)[index] = value
        obj.keyframe_insert(data_path=data_path, index=index, frame=frame, group=component_id)
    action = obj.animation_data.action
    action.name = action_name
    action["es7_managed_stage"] = MANAGED_STAGE
    action["sequence"] = SHOWCASE_TRACK
    action["component_id"] = component_id
    action["action_id"] = action_spec["id"]
    action["segment_start"] = frame_start
    action["segment_end"] = frame_end
    action["target_direction"] = int(direction)
    for curve in action_fcurves(action):
        for keyframe in curve.keyframe_points:
            keyframe.interpolation = "BEZIER"
            keyframe.easing = "AUTO"
    track = obj.animation_data.nla_tracks.new()
    track.name = SHOWCASE_TRACK
    strip = track.strips.new(action_name, frame_start, action)
    strip.name = SHOWCASE_TRACK
    track.mute = False
    obj.animation_data.action = None
    getattr(obj, data_path)[index] = base


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before building the showcase")
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    components = {component["id"]: component for component in schema["components"]}
    stage_b_actions = [action for action in schema["mechanicalActions"] if action.get("stage") == "B"]
    for action_spec in stage_b_actions:
        for target in action_spec["targets"]:
            component_id = target["componentId"]
            obj = bpy.data.objects.get(components[component_id]["nodeName"])
            if not obj:
                fail(f"missing target node for {component_id}")
            build_target(obj, component_id, action_spec, target["direction"])

    marker = bpy.data.objects.get(STAGE_MARKER)
    if not marker:
        marker = bpy.data.objects.new(STAGE_MARKER, None)
        bpy.data.collections["RIG_COMPONENTS"].objects.link(marker)
    marker["stage"] = "B2.2"
    marker["status"] = "stage-b-showcase-built"
    marker["sequence"] = SHOWCASE_TRACK
    marker["frame_start"] = 501
    marker["frame_end"] = 740
    marker["timeline"] = json.dumps(TIMELINE, ensure_ascii=False)
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start = 1
    scene.frame_end = 740
    scene["es7_rig_stage"] = "B2.2-showcase"
    scene["es7_stage_b_review_sequence"] = SHOWCASE_TRACK
    scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))

    print("ES7 STAGE-B SHOWCASE BUILD PASS")
    print("- sequence: stage_b_showcase")
    print("- frame range: 501-740 at 30 fps")
    for label, bounds in TIMELINE.items():
        print(f"- {label}: {bounds[0]}-{bounds[1]}")


if __name__ == "__main__":
    main()
