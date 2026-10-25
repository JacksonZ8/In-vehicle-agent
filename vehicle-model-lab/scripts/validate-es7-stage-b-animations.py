#!/usr/bin/env python3
"""Validate ES7 Stage-B Action/NLA clip contract."""

import json
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-stage-b-animation.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
MANAGED_STAGE = "B2.1"
FPS = 30


def fail(message):
    raise SystemExit(f"ES7 STAGE-B ANIMATION VALIDATION FAILED: {message}")


def action_fcurves(action):
    for layer in action.layers:
        for strip in layer.strips:
            for channelbag in strip.channelbags:
                yield from channelbag.fcurves


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validation")
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    components = {component["id"]: component for component in schema["components"]}
    stage_b_actions = [action for action in schema["mechanicalActions"] if action.get("stage") == "B"]
    found_tracks = 0
    for action_spec in stage_b_actions:
        frame_end = max(2, round(float(action_spec["durationSeconds"]) * FPS) + 1)
        expected_path = "location" if action_spec["type"] == "translate" else "rotation_euler"
        expected_index = {"X": 0, "Y": 1, "Z": 2}[action_spec["axis"]]
        for target in action_spec["targets"]:
            expected_delta = max(abs(float(value)) for value in action_spec["range"]) * int(target["direction"])
            component = components[target["componentId"]]
            obj = bpy.data.objects.get(component["nodeName"])
            if not obj or not obj.animation_data:
                fail(f"missing animation data on {component['nodeName']}")
            tracks = [track for track in obj.animation_data.nla_tracks if track.name == action_spec["clip"]]
            if len(tracks) != 1 or len(tracks[0].strips) != 1:
                fail(f"{component['id']} must have one {action_spec['clip']} track/strip")
            track = tracks[0]
            action = track.strips[0].action
            if not track.mute or not action or action.get("es7_managed_stage") != MANAGED_STAGE:
                fail(f"{component['id']} independent track metadata/mute state is incorrect")
            curves = list(action_fcurves(action))
            if len(curves) != 1:
                fail(f"{component['id']} must animate exactly one curve")
            curve = curves[0]
            if curve.data_path != expected_path or curve.array_index != expected_index:
                fail(f"{component['id']} drives the wrong transform channel")
            keys = curve.keyframe_points
            if len(keys) != 2 or round(keys[0].co.x) != 1 or round(keys[-1].co.x) != frame_end:
                fail(f"{component['id']} keyframe extent is incorrect")
            actual_delta = float(keys[-1].co.y - keys[0].co.y)
            if abs(actual_delta - expected_delta) > 1e-5:
                fail(f"{component['id']} delta is {actual_delta}, expected {expected_delta}")
            if action.get("target_direction") != int(target["direction"]):
                fail(f"{component['id']} target direction metadata is incorrect")
            if {key.interpolation for key in keys} != {"BEZIER"}:
                fail(f"{component['id']} interpolation is incorrect")
            found_tracks += 1

    suspension_targets = next(action for action in stage_b_actions if action["id"] == "suspension_raise")["targets"]
    wheel_nodes = {
        "wheel_front_left_steer", "wheel_front_right_steer", "wheel_front_left_spin",
        "wheel_front_right_spin", "wheel_rear_left_spin", "wheel_rear_right_spin",
    }
    for component_id in wheel_nodes:
        obj = bpy.data.objects[components[component_id]["nodeName"]]
        if any(track.name == "suspension_raise" for track in (obj.animation_data.nla_tracks if obj.animation_data else [])):
            fail(f"suspension incorrectly animates {component_id}")
    if wheel_nodes.intersection(target["componentId"] for target in suspension_targets):
        fail("schema suspension targets include a wheel node")

    marker = bpy.data.objects.get("ES7_STAGE_B2_MECHANICAL_ANIMATIONS")
    if not marker or marker.get("clip_count") != len(stage_b_actions) or marker.get("target_action_count") != found_tracks:
        fail("Stage-B animation marker differs from Blender data")
    if not CHECKPOINT_PATH.exists() or CHECKPOINT_PATH.stat().st_size == 0:
        fail("pre-Stage-B animation checkpoint is missing")

    print("ES7 STAGE-B ANIMATION VALIDATION PASS")
    print(f"- mechanical clips: {len(stage_b_actions)}")
    print(f"- target actions/NLA tracks: {found_tracks}")
    print("- suspension wheel tracks: 0")


if __name__ == "__main__":
    main()
