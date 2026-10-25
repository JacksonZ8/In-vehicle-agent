#!/usr/bin/env python3
"""Validate the four independently scrubbable ES7 seat clips."""

import json
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
MARKER_NAME = "ES7_SEAT_ANIMATIONS"
MANAGED_STAGE = "C1"


def fail(message):
    raise SystemExit(f"ES7 SEAT ANIMATION VALIDATION FAILED: {message}")


def action_fcurves(action):
    for layer in action.layers:
        for strip in layer.strips:
            for channelbag in strip.channelbags:
                yield from channelbag.fcurves


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validating seat animations")
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    components = {component["id"]: component for component in schema["components"]}
    specs = [action for action in schema["mechanicalActions"] if action.get("stage") == "C"]
    found = []
    for spec in specs:
        target = spec["targets"][0]
        component = components[target["componentId"]]
        obj = bpy.data.objects.get(component["nodeName"])
        if obj is None or not obj.animation_data:
            fail(f"missing animation target {component['nodeName']}")
        tracks = [track for track in obj.animation_data.nla_tracks if track.name == spec["clip"]]
        if len(tracks) != 1 or len(tracks[0].strips) != 1 or not tracks[0].mute:
            fail(f"{spec['clip']} must have one muted independent NLA track")
        action = tracks[0].strips[0].action
        if action is None or action.get("es7_managed_stage") != MANAGED_STAGE:
            fail(f"{spec['clip']} action metadata is missing")
        curves = list(action_fcurves(action))
        if len(curves) != 1:
            fail(f"{spec['clip']} must drive exactly one curve")
        curve = curves[0]
        expected_path = "location" if spec["type"] == "translate" else "rotation_euler"
        expected_index = {"X": 0, "Y": 1, "Z": 2}[spec["axis"]]
        if curve.data_path != expected_path or curve.array_index != expected_index:
            fail(f"{spec['clip']} drives the wrong transform channel")
        keys = curve.keyframe_points
        if len(keys) != 2:
            fail(f"{spec['clip']} must have two endpoint keys")
        base = float(action["base_value"])
        expected_values = [base + float(value) for value in spec["range"]]
        actual_values = [float(keys[0].co.y), float(keys[-1].co.y)]
        if any(abs(actual - expected) > 1e-5 for actual, expected in zip(actual_values, expected_values)):
            fail(f"{spec['clip']} endpoint values differ: {actual_values} / {expected_values}")
        if abs(float(getattr(obj, expected_path)[expected_index]) - base) > 1e-6:
            fail(f"{spec['clip']} target is not at its rest transform")
        found.append(spec["clip"])

    marker = bpy.data.objects.get(MARKER_NAME)
    if marker is None or marker.get("status") != "four-independent-driver-seat-slider-clips":
        fail("seat animation marker is missing")
    if int(marker.get("clip_count", -1)) != len(specs):
        fail("seat animation marker clip count differs")
    print("ES7 SEAT ANIMATION VALIDATION PASS")
    print(f"- independent slider clips: {found}")
    print("- each clip drives exactly one declared transform channel")


if __name__ == "__main__":
    main()
