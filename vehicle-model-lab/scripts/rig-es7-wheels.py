#!/usr/bin/env python3
"""Build ES7 steer/spin wheel hierarchies and isolate static calipers."""

import json
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SOURCE_MAP_PATH = LAB_ROOT / "schema" / "es7-source-map.json"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
WORK_PREFIX = "es7_work__"
STAGE_MARKER = "ES7_STAGE_A2_WHEEL_RIG"
CALIPER_MATERIAL = "4_轮胎_卡钳"
ROTOR_MATERIALS = {"4_轮胎_轮毂暗面", "4_轮胎_刹车片"}


CORNER_CONFIG = {
    "front_left": {"sourceId": "wheel_front_left", "steerId": "wheel_front_left_steer", "spinId": "wheel_front_left_spin"},
    "front_right": {"sourceId": "wheel_front_right", "steerId": "wheel_front_right_steer", "spinId": "wheel_front_right_spin"},
    "rear_left": {"sourceId": "wheel_rear_left", "steerId": None, "spinId": "wheel_rear_left_spin"},
    "rear_right": {"sourceId": "wheel_rear_right", "steerId": None, "spinId": "wheel_rear_right_spin"},
}


def fail(message):
    raise SystemExit(f"ES7 WHEEL RIG FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def mesh_counts(mesh):
    mesh.calc_loop_triangles()
    return len(mesh.vertices), len(mesh.polygons), len(mesh.loop_triangles)


def keep_materials(mesh, allowed_names):
    allowed_indices = {
        index for index, material in enumerate(mesh.materials)
        if material and material.name in allowed_names
    }
    if not allowed_indices:
        fail(f"none of {sorted(allowed_names)} exist on {mesh.name}")
    bm = bmesh.new()
    bm.from_mesh(mesh)
    faces_to_delete = [face for face in bm.faces if face.material_index not in allowed_indices]
    bmesh.ops.delete(bm, geom=faces_to_delete, context="FACES")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


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
    collection.objects.link(pivot)
    return pivot


def reparent_preserving_world(obj, parent):
    matrix_world = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_world = matrix_world


def split_brake_object(caliper_source, corner):
    before_vertices, before_polygons, before_triangles = mesh_counts(caliper_source.data)
    rotor = caliper_source.copy()
    rotor.data = caliper_source.data.copy()
    rotor.name = f"brake_rotor_{corner}"
    rotor.data.name = rotor.name + "_mesh"
    rotor["source_object_name"] = caliper_source.get("source_object_name", caliper_source.name)
    rotor["source_author"] = "ItsDiyor"
    rotor["source_license"] = "CC BY 4.0"
    bpy.data.collections["MODEL_ES7"].objects.link(rotor)

    keep_materials(rotor.data, ROTOR_MATERIALS)
    keep_materials(caliper_source.data, {CALIPER_MATERIAL})
    caliper_source.name = f"brake_caliper_{corner}"
    caliper_source.data.name = caliper_source.name + "_mesh"

    _, rotor_polygons, rotor_triangles = mesh_counts(rotor.data)
    _, caliper_polygons, caliper_triangles = mesh_counts(caliper_source.data)
    if rotor_polygons + caliper_polygons != before_polygons:
        fail(f"{corner} brake polygon conservation failed")
    if rotor_triangles + caliper_triangles != before_triangles:
        fail(f"{corner} brake triangle conservation failed")
    rotor["component_role"] = "rotating_brake_disc"
    rotor["split_source_polygons"] = before_polygons
    rotor["split_source_triangles"] = before_triangles
    caliper_source["component_role"] = "static_brake_caliper"
    caliper_source["split_source_polygons"] = before_polygons
    caliper_source["split_source_triangles"] = before_triangles
    return rotor, caliper_source


def rig_corner(corner, config, source_map, components, vehicle_root, rig_collection):
    source_objects = source_map["components"][config["sourceId"]]["sourceObjects"]
    if len(source_objects) != 2:
        fail(f"{corner} must map to a wheel and brake object")
    wheel = bpy.data.objects.get(WORK_PREFIX + source_objects[0])
    caliper_source = bpy.data.objects.get(WORK_PREFIX + source_objects[1])
    if not wheel or not caliper_source:
        fail(f"{corner} working wheel or caliper is missing")
    minimum, maximum = world_bounds(wheel)
    center = (minimum + maximum) * 0.5

    if config["steerId"]:
        steer = create_pivot(
            components[config["steerId"]]["nodeName"],
            vehicle_root,
            center,
            rig_collection,
            "wheel_steering",
            config["steerId"],
        )
        steer["steer_axis"] = "Z"
        steer["steer_range_radians"] = [-0.52, 0.52]
        spin_parent = steer
    else:
        steer = None
        spin_parent = vehicle_root

    spin = create_pivot(
        components[config["spinId"]]["nodeName"],
        spin_parent,
        center,
        rig_collection,
        "wheel_spin",
        config["spinId"],
    )
    spin["spin_axis"] = "Y"
    spin["loop_radians"] = 6.283185307179586

    rotor, caliper = split_brake_object(caliper_source, corner)
    wheel.name = f"wheel_mesh_{corner}"
    wheel.data.name = wheel.name + "_mesh"
    wheel["component_id"] = config["spinId"]
    rotor["component_id"] = config["spinId"]
    caliper["component_id"] = config["steerId"] or config["spinId"]
    reparent_preserving_world(wheel, spin)
    reparent_preserving_world(rotor, spin)
    reparent_preserving_world(caliper, steer or vehicle_root)
    return {
        "corner": corner,
        "steer": steer.name if steer else None,
        "spin": spin.name,
        "wheel": wheel.name,
        "rotor": rotor.name,
        "caliper": caliper.name,
        "center": [round(value, 6) for value in center],
    }


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before rigging wheels")
    if bpy.data.objects.get(STAGE_MARKER):
        fail("wheel rig has already been applied")
    source_map = load_json(SOURCE_MAP_PATH)
    schema = load_json(SCHEMA_PATH)
    components = {component["id"]: component for component in schema["components"]}
    vehicle_root = bpy.data.objects.get("vehicle_root")
    rig_collection = bpy.data.collections.get("RIG_COMPONENTS")
    if not vehicle_root or not rig_collection:
        fail("vehicle_root or RIG_COMPONENTS is missing")

    results = [
        rig_corner(corner, config, source_map, components, vehicle_root, rig_collection)
        for corner, config in CORNER_CONFIG.items()
    ]
    marker = bpy.data.objects.new(STAGE_MARKER, None)
    marker.empty_display_size = 0.08
    marker["stage"] = "A2.1"
    marker["status"] = "steer-spin-and-brake-hierarchy-rigged"
    marker["corners"] = [result["corner"] for result in results]
    rig_collection.objects.link(marker)
    bpy.context.scene["es7_rig_stage"] = "A2.1-wheels"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))

    print("ES7 WHEEL RIG PASS")
    for result in results:
        print(f"- {result['corner']}: steer={result['steer']} spin={result['spin']} center={result['center']}")


if __name__ == "__main__":
    main()
