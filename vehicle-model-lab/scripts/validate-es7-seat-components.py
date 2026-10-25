#!/usr/bin/env python3
"""Validate ES7 seat geometry conservation, hierarchy, focus tags, and control composition."""

from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-seat-components.blend"
MARKER_NAME = "ES7_SEAT_COMPONENTS"
SOURCE_NAME = "es7_work__ES7_Body_C"
ORIGINAL_OBJECTS = (
    SOURCE_NAME,
    "driver_seat_base_mesh",
    "passenger_seat_base_mesh",
    "rear_left_center_seat_mesh",
    "rear_right_seat_mesh",
)
PARENTS = {
    "driver_seat_track_static": "body_static",
    "driver_seat_fore_aft": "driver_seat_track_static",
    "driver_seat_height": "driver_seat_fore_aft",
    "driver_seat_base_mesh": "driver_seat_height",
    "driver_seat_backrest_pivot": "driver_seat_height",
    "driver_seat_headrest_slider": "driver_seat_backrest_pivot",
    "passenger_seat_static": "body_static",
    "passenger_seat_base_mesh": "passenger_seat_static",
    "passenger_seat_backrest_pivot": "passenger_seat_static",
    "rear_left_seat_static": "body_static",
    "rear_left_center_seat_mesh": "rear_left_seat_static",
    "rear_right_seat_static": "body_static",
    "rear_right_seat_mesh": "rear_right_seat_static",
}


def fail(message):
    raise SystemExit(f"ES7 SEAT COMPONENT VALIDATION FAILED: {message}")


def mesh_counts(objects):
    vertices = polygons = triangles = 0
    for obj in objects:
        obj.data.calc_loop_triangles()
        vertices += len(obj.data.vertices)
        polygons += len(obj.data.polygons)
        triangles += len(obj.data.loop_triangles)
    return vertices, polygons, triangles


def center_world(obj):
    return sum((obj.matrix_world @ Vector(corner) for corner in obj.bound_box), Vector()) / 8.0


def matrix_error(first, second):
    return max(abs(first[row][column] - second[row][column]) for row in range(4) for column in range(4))


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validating")
    marker = bpy.data.objects.get(MARKER_NAME)
    if marker is None or marker.get("status") != "approved-front-seat-backrests-and-four-seat-focus-groups":
        fail("seat component marker is missing")
    if not CHECKPOINT_PATH.exists() or CHECKPOINT_PATH.stat().st_size == 0:
        fail("pre-seat checkpoint is missing")

    for child_name, parent_name in PARENTS.items():
        child = bpy.data.objects.get(child_name)
        parent = bpy.data.objects.get(parent_name)
        if child is None or parent is None or child.parent != parent:
            fail(f"incorrect hierarchy: {child_name} -> {parent_name}")
    if any("candidate" in obj.name for obj in bpy.data.objects):
        fail("dry-run candidate objects leaked into the master")

    original_objects = [bpy.data.objects.get(name) for name in ORIGINAL_OBJECTS]
    if any(obj is None or obj.type != "MESH" for obj in original_objects):
        fail("one or more conserved original seat/body meshes are missing")
    actual_counts = mesh_counts(original_objects)
    expected_counts = (
        int(marker["original_vertices"]),
        int(marker["original_polygons"]),
        int(marker["original_triangles"]),
    )
    if actual_counts != expected_counts:
        fail(f"original geometry changed: actual={actual_counts}, expected={expected_counts}")

    focus_groups = {
        obj.get("seat_focus_group")
        for obj in bpy.data.objects
        if obj.get("seat_focus_group")
    }
    if not {"front_left", "front_right", "rear_left", "rear_right"}.issubset(focus_groups):
        fail(f"missing focus groups: {sorted(focus_groups)}")
    focus_materials = {
        material.get("seat_focus_semantic")
        for material in bpy.data.materials
        if material.get("seat_focus_semantic")
    }
    required_materials = {"clear_rear_left", "ghost_rear_center", "clear_rear_right"}
    if not required_materials.issubset(focus_materials):
        fail(f"rear focus material tags are incomplete: {sorted(focus_materials)}")

    scene = bpy.context.scene
    scene.frame_set(1)
    bpy.context.view_layer.update()
    driver_base = bpy.data.objects["driver_seat_base_mesh"]
    driver_backrest = bpy.data.objects["driver_seat_backrest_core"]
    driver_headrest = bpy.data.objects["driver_seat_headrest"]
    rails = [bpy.data.objects["driver_seat_track_left"], bpy.data.objects["driver_seat_track_right"]]
    before = {
        "base": center_world(driver_base),
        "backrest": center_world(driver_backrest),
        "headrest": center_world(driver_headrest),
        "rails": [rail.matrix_world.copy() for rail in rails],
    }
    fore = bpy.data.objects["driver_seat_fore_aft"]
    height = bpy.data.objects["driver_seat_height"]
    backrest_pivot = bpy.data.objects["driver_seat_backrest_pivot"]
    headrest_slider = bpy.data.objects["driver_seat_headrest_slider"]
    headrest_rest_location = headrest_slider.location.copy()
    fore.location.x = 0.10
    height.location.z = 0.05
    backrest_pivot.rotation_euler.y -= 0.20
    headrest_slider.location.z += 0.05
    bpy.context.view_layer.update()

    base_delta = center_world(driver_base) - before["base"]
    if abs(base_delta.x - 0.10) > 1e-5 or abs(base_delta.z - 0.05) > 1e-5:
        fail(f"driver base does not compose fore/aft and height: {tuple(base_delta)}")
    if (center_world(driver_backrest) - before["backrest"]).length < 0.05:
        fail("driver backrest did not inherit seat translation and recline")
    if (center_world(driver_headrest) - before["headrest"]).length < 0.05:
        fail("driver headrest did not inherit backrest and independent lift")
    if any(matrix_error(rail.matrix_world, matrix) > 1e-6 for rail, matrix in zip(rails, before["rails"])):
        fail("fixed driver rails moved with seat controls")

    fore.location.x = 0.0
    height.location.z = 0.0
    backrest_pivot.rotation_euler.y += 0.20
    headrest_slider.location = headrest_rest_location
    bpy.context.view_layer.update()
    if (center_world(driver_base) - before["base"]).length > 0.00002:
        fail("driver base does not return to rest")
    if (center_world(driver_backrest) - before["backrest"]).length > 0.00002:
        fail("driver backrest does not return to rest")
    if (center_world(driver_headrest) - before["headrest"]).length > 0.00002:
        fail("driver headrest does not return to rest")

    print("ES7 SEAT COMPONENT VALIDATION PASS")
    print(f"- conserved original geometry vertices/polygons/triangles: {actual_counts}")
    print(f"- focus groups: {sorted(focus_groups)}")
    print(f"- rear material semantics: {sorted(focus_materials)}")
    print("- driver controls compose and fixed tracks remain stationary")


if __name__ == "__main__":
    main()
