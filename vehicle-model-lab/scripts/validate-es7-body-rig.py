#!/usr/bin/env python3
"""Validate the ES7 Stage-A body-component pivot hierarchy."""

import json
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
SOURCE_MAP_PATH = LAB_ROOT / "schema" / "es7-source-map.json"
WORK_PREFIX = "es7_work__"


def fail(message):
    raise SystemExit(f"ES7 BODY RIG VALIDATION FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def has_ancestor(obj, ancestor):
    parent = obj.parent
    while parent:
        if parent == ancestor:
            return True
        parent = parent.parent
    return False


def source_object(source_map, component_id):
    source_names = source_map["components"][component_id]["sourceObjects"]
    if len(source_names) != 1:
        fail(f"{component_id} source mapping is not singular")
    obj = bpy.data.objects.get(WORK_PREFIX + source_names[0])
    if obj is None:
        fail(f"missing working source object for {component_id}")
    return obj


def validate_component(obj, pivot, component_id):
    if not has_ancestor(obj, pivot):
        fail(f"{obj.name} is not under {pivot.name}")
    if obj.get("component_id") != component_id:
        fail(f"{obj.name} has incorrect component_id")
    if len(obj.get("rig_bind_matrix_world", [])) != 16:
        fail(f"{obj.name} is missing its bind matrix")


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validation")
    schema = load_json(SCHEMA_PATH)
    source_map = load_json(SOURCE_MAP_PATH)
    components = {component["id"]: component for component in schema["components"]}

    vehicle_root = bpy.data.objects.get("vehicle_root")
    body_static = bpy.data.objects.get("body_static")
    normalization = bpy.data.objects.get("source_normalization")
    if not vehicle_root or not body_static or not normalization:
        fail("missing vehicle/body/normalization hierarchy")
    if body_static.parent != vehicle_root or normalization.parent != body_static:
        fail("body_static hierarchy is incorrect")

    door_ids = (
        "front_left_door",
        "front_right_door",
        "rear_left_door",
        "rear_right_door",
    )
    for door_id in door_ids:
        door_pivot = bpy.data.objects.get(components[door_id]["nodeName"])
        if not door_pivot or door_pivot.parent != vehicle_root:
            fail(f"missing or mis-parented {door_id} pivot")
        if door_pivot.get("hinge_axis") != "Z":
            fail(f"{door_id} hinge axis must be Z")
        validate_component(source_object(source_map, door_id), door_pivot, door_id)

        window_id = door_id.replace("door", "window")
        window_pivot = bpy.data.objects.get(components[window_id]["nodeName"])
        if not window_pivot or window_pivot.parent != door_pivot:
            fail(f"missing or mis-parented {window_id} pivot")
        validate_component(source_object(source_map, window_id), window_pivot, window_id)

        handle_id = door_id.replace("door", "handle")
        handle_pivot = bpy.data.objects.get(components[handle_id]["nodeName"])
        if not handle_pivot or handle_pivot.parent != door_pivot:
            fail(f"missing or mis-parented {handle_id} pivot")
        validate_component(source_object(source_map, handle_id), handle_pivot, handle_id)
        handle_light_id = handle_id + "_light"
        validate_component(source_object(source_map, handle_light_id), handle_pivot, handle_light_id)

    tailgate_pivot = bpy.data.objects.get(components["tailgate"]["nodeName"])
    if not tailgate_pivot or tailgate_pivot.parent != vehicle_root:
        fail("missing or mis-parented tailgate pivot")
    if tailgate_pivot.get("hinge_axis") != "Y":
        fail("tailgate hinge axis must be Y")
    validate_component(source_object(source_map, "tailgate"), tailgate_pivot, "tailgate")

    marker = bpy.data.objects.get("ES7_STAGE_A1_BODY_RIG")
    if not marker or marker.get("status") != "doors-windows-handles-tailgate-rigged":
        fail("Stage A1 marker is missing")

    print("ES7 BODY RIG VALIDATION PASS")
    print("- doors/windows/handles/handle-lights: 4/4/4/4")
    print("- tailgate: 1")
    print("- body_static -> source_normalization hierarchy: valid")


if __name__ == "__main__":
    main()
