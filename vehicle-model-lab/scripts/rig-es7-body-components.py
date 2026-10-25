#!/usr/bin/env python3
"""Build stable Stage-A pivots for ES7 doors, windows, handles, and tailgate."""

import json
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SOURCE_MAP_PATH = LAB_ROOT / "schema" / "es7-source-map.json"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
WORK_PREFIX = "es7_work__"
STAGE_MARKER = "ES7_STAGE_A1_BODY_RIG"


DOOR_IDS = (
    "front_left_door",
    "front_right_door",
    "rear_left_door",
    "rear_right_door",
)


def fail(message):
    raise SystemExit(f"ES7 BODY RIG FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def matrix_values(matrix):
    return [round(float(matrix[row][column]), 9) for row in range(4) for column in range(4)]


def matrix_delta(first, second):
    return max(abs(first[row][column] - second[row][column]) for row in range(4) for column in range(4))


def reparent_preserving_world(obj, parent):
    before = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_world = before
    if matrix_delta(before, obj.matrix_world) > 1e-6:
        fail(f"reparent moved {obj.name}")
    obj["rig_bind_matrix_world"] = matrix_values(before)


def create_pivot(name, parent, location, collection, role, component_id):
    if bpy.data.objects.get(name):
        fail(f"pivot already exists: {name}")
    pivot = bpy.data.objects.new(name, None)
    pivot.empty_display_type = "ARROWS"
    pivot.empty_display_size = 0.12
    pivot.rotation_mode = "XYZ"
    pivot.parent = parent
    pivot.matrix_world = Matrix.Translation(Vector(location))
    pivot["contract_role"] = role
    pivot["component_id"] = component_id
    pivot["closed_location"] = [round(value, 9) for value in pivot.location]
    pivot["closed_rotation_euler"] = [0.0, 0.0, 0.0]
    collection.objects.link(pivot)
    return pivot


def source_object(source_map, component_id):
    names = source_map["components"][component_id]["sourceObjects"]
    if len(names) != 1:
        fail(f"{component_id} must map to one whole source object")
    obj = bpy.data.objects.get(WORK_PREFIX + names[0])
    if obj is None:
        fail(f"missing working object for {component_id}: {names[0]}")
    return obj


def component_by_id(schema):
    return {component["id"]: component for component in schema["components"]}


def action_by_id(schema):
    return {action["id"]: action for action in schema["mechanicalActions"]}


def rig_door(component_id, source_map, components, actions, vehicle_root, rig_collection):
    door = source_object(source_map, component_id)
    minimum, maximum = world_bounds(door)
    center = (minimum + maximum) * 0.5
    pivot = create_pivot(
        components[component_id]["nodeName"],
        vehicle_root,
        (maximum.x - 0.012, center.y, center.z),
        rig_collection,
        "door_hinge",
        component_id,
    )
    pivot["hinge_axis"] = "Z"
    pivot["open_radians"] = max(abs(value) for value in actions[f"{component_id}_open"]["range"])
    reparent_preserving_world(door, pivot)
    door["component_id"] = component_id

    window_id = component_id.replace("door", "window")
    window = source_object(source_map, window_id)
    window_minimum, window_maximum = world_bounds(window)
    window_center = (window_minimum + window_maximum) * 0.5
    window_pivot = create_pivot(
        components[window_id]["nodeName"],
        pivot,
        window_center,
        rig_collection,
        "window_slider",
        window_id,
    )
    window_pivot["slide_axis"] = "Z"
    window_pivot["open_distance_m"] = max(abs(value) for value in actions[f"{window_id}_open"]["range"])
    reparent_preserving_world(window, window_pivot)
    window["component_id"] = window_id

    handle_id = component_id.replace("door", "handle")
    handle = source_object(source_map, handle_id)
    handle_minimum, handle_maximum = world_bounds(handle)
    handle_center = (handle_minimum + handle_maximum) * 0.5
    handle_pivot = create_pivot(
        components[handle_id]["nodeName"],
        pivot,
        handle_center,
        rig_collection,
        "flush_handle_slider",
        handle_id,
    )
    handle_pivot["deploy_axis"] = "Y"
    handle_pivot["deploy_distance_m"] = max(abs(value) for value in actions[f"{handle_id}_deploy"]["range"])
    reparent_preserving_world(handle, handle_pivot)
    handle["component_id"] = handle_id

    handle_light_id = handle_id + "_light"
    handle_light = source_object(source_map, handle_light_id)
    reparent_preserving_world(handle_light, handle_pivot)
    handle_light["component_id"] = handle_light_id
    return pivot


def rig_tailgate(source_map, components, actions, vehicle_root, rig_collection):
    tailgate = source_object(source_map, "tailgate")
    minimum, maximum = world_bounds(tailgate)
    pivot = create_pivot(
        components["tailgate"]["nodeName"],
        vehicle_root,
        (maximum.x - 0.02, (minimum.y + maximum.y) * 0.5, maximum.z - 0.018),
        rig_collection,
        "tailgate_hinge",
        "tailgate",
    )
    pivot["hinge_axis"] = "Y"
    pivot["open_radians"] = max(abs(value) for value in actions["tailgate_open"]["range"])
    pivot["open_direction"] = 1
    reparent_preserving_world(tailgate, pivot)
    tailgate["component_id"] = "tailgate"
    return pivot


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before rigging")
    if bpy.data.objects.get(STAGE_MARKER):
        fail("Stage A1 body rig has already been applied")

    source_map = load_json(SOURCE_MAP_PATH)
    schema = load_json(SCHEMA_PATH)
    components = component_by_id(schema)
    actions = action_by_id(schema)
    vehicle_root = bpy.data.objects.get("vehicle_root")
    normalization = bpy.data.objects.get("source_normalization")
    rig_collection = bpy.data.collections.get("RIG_COMPONENTS")
    if not vehicle_root or not normalization or not rig_collection:
        fail("master root or RIG_COMPONENTS is missing")

    body_static = create_pivot(
        components["body_static"]["nodeName"],
        vehicle_root,
        (0.0, 0.0, 0.0),
        rig_collection,
        "static_body_root",
        "body_static",
    )
    reparent_preserving_world(normalization, body_static)

    door_pivots = [
        rig_door(component_id, source_map, components, actions, vehicle_root, rig_collection)
        for component_id in DOOR_IDS
    ]
    tailgate_pivot = rig_tailgate(source_map, components, actions, vehicle_root, rig_collection)

    marker = bpy.data.objects.new(STAGE_MARKER, None)
    marker.empty_display_type = "PLAIN_AXES"
    marker.empty_display_size = 0.08
    marker["stage"] = "A1.2"
    marker["status"] = "doors-windows-handles-tailgate-rigged"
    marker["door_pivots"] = [pivot.name for pivot in door_pivots]
    marker["tailgate_pivot"] = tailgate_pivot.name
    rig_collection.objects.link(marker)

    bpy.context.scene["es7_rig_stage"] = "A1.2-body-components"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))
    print("ES7 STAGE A1 BODY RIG PASS")
    print(f"- doors: {len(door_pivots)}")
    print("- windows: 4")
    print("- handles: 4")
    print("- handle lights: 4")
    print(f"- tailgate: {tailgate_pivot.name}")


if __name__ == "__main__":
    main()
