#!/usr/bin/env python3
"""Validate ES7 Stage-A mechanical Action/NLA clip contract."""

import json
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-stage-a-animation.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
STAGE_MARKER = "ES7_STAGE_A3_MECHANICAL_ANIMATIONS"
FPS = 30
OUTWARD_DOOR_ROTATION = {
    "front_left_door_open": -1,
    "rear_left_door_open": -1,
    "front_right_door_open": 1,
    "rear_right_door_open": 1,
}


def fail(message):
    raise SystemExit(f"ES7 STAGE-A ANIMATION VALIDATION FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def action_fcurves(action):
    for layer in action.layers:
        for strip in layer.strips:
            for channelbag in strip.channelbags:
                yield from channelbag.fcurves


def expected_key_count(action_spec):
    minimum, maximum = action_spec["range"]
    return 4 if minimum < 0.0 < maximum else 2


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validation")
    schema = load_json(SCHEMA_PATH)
    components = {component["id"]: component for component in schema["components"]}
    stage_a_actions = [action for action in schema["mechanicalActions"] if action.get("stage") is None]
    found_tracks = 0
    found_actions = set()
    for action_spec in stage_a_actions:
        frame_end = max(2, round(float(action_spec["durationSeconds"]) * FPS) + 1)
        expected_path = "location" if action_spec["type"] == "translate" else "rotation_euler"
        expected_index = {"X": 0, "Y": 1, "Z": 2}[action_spec["axis"]]
        for target in action_spec["targets"]:
            component = components[target["componentId"]]
            obj = bpy.data.objects.get(component["nodeName"])
            if not obj or not obj.animation_data:
                fail(f"missing animation data on {component['nodeName']}")
            tracks = [track for track in obj.animation_data.nla_tracks if track.name == action_spec["clip"]]
            if len(tracks) != 1 or len(tracks[0].strips) != 1:
                fail(f"{component['id']} must have one {action_spec['clip']} track/strip")
            track = tracks[0]
            strip = track.strips[0]
            action = strip.action
            if not track.mute or strip.mute:
                fail(f"{component['id']} independent track mute state is incorrect")
            if not action or action.get("es7_managed_stage") != "A3.1":
                fail(f"{component['id']} action is not managed by A3.1")
            if action.get("clip") != action_spec["clip"] or action.get("component_id") != component["id"]:
                fail(f"{component['id']} action metadata is incorrect")
            if action.get("frame_start") != 1 or action.get("frame_end") != frame_end:
                fail(f"{component['id']} action frame range is incorrect")
            curves = list(action_fcurves(action))
            if len(curves) != 1:
                fail(f"{component['id']} action must animate exactly one curve")
            curve = curves[0]
            if curve.data_path != expected_path or curve.array_index != expected_index:
                fail(f"{component['id']} action drives the wrong transform channel")
            keys = curve.keyframe_points
            if len(keys) != expected_key_count(action_spec):
                fail(f"{component['id']} action key count is incorrect")
            if round(keys[0].co.x) != 1 or round(keys[-1].co.x) != frame_end:
                fail(f"{component['id']} keyframe extent is incorrect")
            if action_spec["id"] in OUTWARD_DOOR_ROTATION:
                actual_sign = 1 if keys[-1].co.y > keys[0].co.y else -1
                if actual_sign != OUTWARD_DOOR_ROTATION[action_spec["id"]]:
                    fail(f"{component['id']} rotates inward instead of outward")
            interpolation = {key.interpolation for key in keys}
            expected_interpolation = {"LINEAR"} if action_spec.get("loop") else {"BEZIER"}
            if interpolation != expected_interpolation:
                fail(f"{component['id']} interpolation is incorrect: {interpolation}")
            found_tracks += 1
            found_actions.add(action.name)

    marker = bpy.data.objects.get(STAGE_MARKER)
    if not marker or marker.get("status") != "mechanical-actions-built":
        fail("mechanical animation stage marker is missing")
    if marker.get("clip_count") != len(stage_a_actions):
        fail("mechanical clip count marker differs from schema")
    if marker.get("target_action_count") != found_tracks:
        fail("target action count marker differs from Blender data")
    if not CHECKPOINT_PATH.exists() or CHECKPOINT_PATH.stat().st_size == 0:
        fail("pre-animation checkpoint is missing")

    print("ES7 STAGE-A ANIMATION VALIDATION PASS")
    print(f"- mechanical clips: {len(stage_a_actions)}")
    print(f"- target actions/NLA tracks: {found_tracks}")
    print(f"- unique managed actions: {len(found_actions)}")
    print(f"- checkpoint bytes: {CHECKPOINT_PATH.stat().st_size}")


if __name__ == "__main__":
    main()
