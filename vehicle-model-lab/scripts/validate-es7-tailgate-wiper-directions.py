#!/usr/bin/env python3
"""Validate approved ES7 tailgate and wiper directions in the Blender master."""

import json
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"


def fail(message):
    raise SystemExit(f"ES7 TAILGATE/WIPER DIRECTION VALIDATION FAILED: {message}")


def world_center(obj):
    minimum, maximum = world_bounds(obj)
    return (minimum + maximum) * 0.5


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validation")
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    actions = {action["id"]: action for action in schema["mechanicalActions"]}
    if actions["tailgate_open"]["range"] != [0.0, 1.08]:
        fail("tailgate schema direction is not positive Y")
    wiper_targets = {
        target["componentId"]: target["direction"]
        for target in actions["wipers_sweep"]["targets"]
    }
    if actions["wipers_sweep"]["range"] != [-1.08, 0.0] or wiper_targets != {
        "wiper_left": -1,
        "wiper_right": -1,
    }:
        fail("wiper schema does not define both original assemblies as negative local Z")
    marker = bpy.data.objects.get("ES7_TAILGATE_WIPER_DIRECTION_FIX")
    if not marker or marker.get("status") != "tailgate-positive-y-wipers-negative-z":
        fail("tailgate/wiper direction marker is missing")
    rigid_marker = bpy.data.objects.get("ES7_ORIGINAL_WIPER_RIGID_ASSEMBLY")
    if not rigid_marker or rigid_marker.get("status") != "original-islands-rigid-chain-with-correct-spindle":
        fail("original rigid-wiper marker is missing")

    scene = bpy.context.scene
    scene.frame_set(311)
    bpy.context.view_layer.update()
    tailgate_closed = world_center(bpy.data.objects["es7_work__Trunk"])
    scene.frame_set(346)
    bpy.context.view_layer.update()
    tailgate_open = world_center(bpy.data.objects["es7_work__Trunk"])
    tailgate_delta = tailgate_open - tailgate_closed
    if tailgate_delta.x >= -0.15 or tailgate_delta.z <= 0.25:
        fail(f"tailgate does not move outward/upward: delta={tuple(tailgate_delta)}")

    wiper_rises = {}
    wiper_displacements = {}
    for name, pivot_name, expected_sign in (
        ("wiper_left_mesh", "wiper_left_pivot", -1),
        ("wiper_right_mesh", "wiper_right_pivot", -1),
    ):
        scene.frame_set(601)
        bpy.context.view_layer.update()
        closed_center = world_center(bpy.data.objects[name])
        _, closed_maximum = world_bounds(bpy.data.objects[name])
        scene.frame_set(636)
        bpy.context.view_layer.update()
        opened_center = world_center(bpy.data.objects[name])
        _, opened_maximum = world_bounds(bpy.data.objects[name])
        pivot_rotation = bpy.data.objects[pivot_name].rotation_euler.z
        wiper_rises[name] = opened_maximum.z - closed_maximum.z
        wiper_displacements[name] = (opened_center - closed_center).length
        if pivot_rotation * expected_sign <= 1.0:
            fail(f"{pivot_name} does not use the approved local Z sign: {pivot_rotation}")
        if wiper_displacements[name] <= 0.15:
            fail(f"{name} does not move through a meaningful sweep: {wiper_displacements[name]}")
    for name, rise in wiper_rises.items():
        if rise <= 0.15:
            fail(f"{name} does not rise through the windshield: {rise}")

    print("ES7 TAILGATE/WIPER DIRECTION VALIDATION PASS")
    print(f"- tailgate outward/up delta X/Z: {tailgate_delta.x:.4f}/{tailgate_delta.z:.4f} m")
    print(
        "- wiper mesh displacement lengths: "
        f"{wiper_displacements['wiper_left_mesh']:.4f}/{wiper_displacements['wiper_right_mesh']:.4f} m"
    )


if __name__ == "__main__":
    main()
