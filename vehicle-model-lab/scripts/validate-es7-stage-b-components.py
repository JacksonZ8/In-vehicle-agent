#!/usr/bin/env python3
"""Validate ES7 Stage-B extracted components, pivots, and hierarchy."""

import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-stage-b-components.blend"


def fail(message):
    raise SystemExit(f"ES7 STAGE-B COMPONENT VALIDATION FAILED: {message}")


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validation")
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    components = {component["id"]: component for component in schema["components"]}
    stage_b_components = [component for component in schema["components"] if component.get("requiredStageB")]
    if len(stage_b_components) != 7:
        fail("schema must define seven Stage-B components")

    for component in stage_b_components:
        obj = bpy.data.objects.get(component["nodeName"])
        if not obj:
            fail(f"missing node {component['nodeName']}")
        parent_component = components.get(component["parent"])
        expected_parent = parent_component["nodeName"] if parent_component else None
        actual_parent = obj.parent.name if obj.parent else None
        if actual_parent != expected_parent:
            fail(f"{obj.name} parent is {actual_parent}, expected {expected_parent}")
        if obj.get("component_id") != component["id"]:
            fail(f"{obj.name} component metadata is missing")

    extracted_meshes = {
        "charge_port_mesh": (1, "charge_port_pivot"),
        "mirror_left_mesh": (1, "mirror_left_fold"),
        "mirror_right_mesh": (1, "mirror_right_fold"),
        "wiper_left_mesh": (1, "wiper_left_pivot"),
        "wiper_right_mesh": (1, "wiper_right_pivot"),
    }
    for name, (_, parent_name) in extracted_meshes.items():
        obj = bpy.data.objects.get(name)
        if not obj or obj.type != "MESH" or len(obj.data.polygons) == 0:
            fail(f"{name} is missing or empty")
        if not obj.parent or obj.parent.name != parent_name:
            fail(f"{name} is not parented to {parent_name}")

    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    charge_mesh = bpy.data.objects["charge_port_mesh"]
    charge_minimum, charge_maximum = world_bounds(charge_mesh)
    charge_center = (charge_minimum + charge_maximum) * 0.5
    expected_charge_origin = Vector((charge_maximum.x, charge_center.y, charge_center.z))
    charge_origin = bpy.data.objects["charge_port_pivot"].matrix_world.translation
    if (charge_origin - expected_charge_origin).length > 0.01:
        fail(f"charge-port hinge is {tuple(charge_origin)}, expected {tuple(expected_charge_origin)}")

    for indicator_name, expected_origin in {
        "indicator_front_left": (0.86, 0.93, 1.22),
        "indicator_front_right": (0.86, -0.93, 1.22),
    }.items():
        indicator = bpy.data.objects.get(indicator_name)
        if not indicator or indicator.get("stage_b_rotation_origin") is None:
            fail(f"{indicator_name} did not receive its fold origin")
        actual = tuple(round(float(value), 2) for value in indicator.matrix_world.translation)
        if actual != expected_origin:
            fail(f"{indicator_name} origin is {actual}, expected {expected_origin}")

    suspension = bpy.data.objects["suspension_height"]
    if suspension.get("raise_meters") != 0.06 or not suspension.get("wheel_nodes_excluded"):
        fail("suspension-height metadata is incorrect")
    marker = bpy.data.objects.get("ES7_STAGE_B_COMPONENT_RIG")
    if not marker or marker.get("status") != "charge-mirrors-wipers-height-rigged":
        fail("Stage-B component marker is missing")
    if not CHECKPOINT_PATH.exists() or CHECKPOINT_PATH.stat().st_size == 0:
        fail("pre-Stage-B component checkpoint is missing")

    print("ES7 STAGE-B COMPONENT VALIDATION PASS")
    print("- stable component nodes/hierarchy: 7/7")
    print("- extracted moving meshes: 5/5")
    print("- charge-port hinge displacement tolerance: <= 1 cm")
    print("- mirror indicator fold origins: 2/2")
    print("- suspension wheels excluded: yes")


if __name__ == "__main__":
    main()
