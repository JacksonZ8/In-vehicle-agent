#!/usr/bin/env python3
"""Validate the A0 non-destructive ES7 animation master."""

import json
from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-a0-baseline.blend"
METADATA_PATH = LAB_ROOT / "references" / "es7-cc-by" / "metadata.json"
WORK_PREFIX = "es7_work__"


def fail(message):
    raise SystemExit(f"ES7 MASTER VALIDATION FAILED: {message}")


def world_center(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return (minimum + maximum) * 0.5


def close(actual, expected, tolerance=1e-5):
    return abs(actual - expected) <= tolerance


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validation")

    expected_collections = {
        "SOURCE_ES7_LOCKED",
        "MODEL_ES7",
        "RIG_COMPONENTS",
        "LIGHTING_PREVIEW",
        "EXPORT_ONLY",
    }
    scene_collections = {collection.name for collection in bpy.context.scene.collection.children}
    missing_collections = sorted(expected_collections - scene_collections)
    if missing_collections:
        fail(f"missing top-level collections: {', '.join(missing_collections)}")

    source_collection = bpy.data.collections["SOURCE_ES7_LOCKED"]
    if not source_collection.hide_viewport or not source_collection.hide_render:
        fail("SOURCE_ES7_LOCKED must be hidden in viewport and render")
    if not source_collection.get("export_forbidden"):
        fail("SOURCE_ES7_LOCKED must be export-forbidden")

    source_objects = [obj for obj in source_collection.all_objects if obj.name != "ES7_CC_BY_REFERENCE_ROOT"]
    work_objects = [obj for obj in bpy.data.objects if obj.name.startswith(WORK_PREFIX)]
    source_meshes = [obj for obj in source_objects if obj.type == "MESH"]
    work_meshes = [obj for obj in work_objects if obj.type == "MESH"]
    if len(source_objects) != 96 or len(work_objects) != 96:
        fail(f"expected 96 source/work objects, got {len(source_objects)}/{len(work_objects)}")
    if len(source_meshes) != 47 or len(work_meshes) != 47:
        fail(f"expected 47 source/work meshes, got {len(source_meshes)}/{len(work_meshes)}")

    source_triangles = 0
    work_triangles = 0
    for obj in source_meshes:
        obj.data.calc_loop_triangles()
        source_triangles += len(obj.data.loop_triangles)
    for obj in work_meshes:
        obj.data.calc_loop_triangles()
        work_triangles += len(obj.data.loop_triangles)
    if source_triangles != 588958 or work_triangles != 588958:
        fail(f"triangle baseline changed: {source_triangles}/{work_triangles}")

    vehicle_root = bpy.data.objects.get("vehicle_root")
    normalization = bpy.data.objects.get("source_normalization")
    work_root = bpy.data.objects.get("es7_work_asset_root")
    if not vehicle_root or not normalization or not work_root:
        fail("missing root hierarchy")
    if normalization.parent != vehicle_root or work_root.parent != normalization:
        fail("root hierarchy is incorrect")
    if any(not close(value, 0.0) for value in vehicle_root.location):
        fail("vehicle_root location must remain zero")
    if any(not close(value, 1.0) for value in vehicle_root.scale):
        fail("vehicle_root scale must remain one")
    if normalization.get("axis_contract") != "+X front, +Y left, +Z up":
        fail("normalization axis contract is missing")

    metadata = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    target_wheelbase = metadata["officialDimensions"]["wheelbaseMm"] / 1000.0
    front_left = world_center(bpy.data.objects[WORK_PREFIX + "Wheel1_3"])
    front_right = world_center(bpy.data.objects[WORK_PREFIX + "Wheel1_1"])
    rear_left = world_center(bpy.data.objects[WORK_PREFIX + "Wheel1_2"])
    rear_right = world_center(bpy.data.objects[WORK_PREFIX + "Wheel1"])
    front_axle_x = (front_left.x + front_right.x) * 0.5
    rear_axle_x = (rear_left.x + rear_right.x) * 0.5
    measured_wheelbase = abs(front_axle_x - rear_axle_x)
    if not close(measured_wheelbase, target_wheelbase, 1e-4):
        fail(f"normalized wheelbase is {measured_wheelbase}, expected {target_wheelbase}")
    if not (front_left.x > rear_left.x and front_left.y > 0 and rear_left.y > 0):
        fail("normalized left wheel positions do not match +X front/+Y left")

    camera_names = {obj.name for obj in bpy.data.collections["LIGHTING_PREVIEW"].all_objects if obj.type == "CAMERA"}
    expected_cameras = {"ES7_REVIEW_front45", "ES7_REVIEW_side", "ES7_REVIEW_rear45"}
    if camera_names != expected_cameras:
        fail(f"review cameras mismatch: {sorted(camera_names)}")
    if not bpy.data.collections["LIGHTING_PREVIEW"].get("export_forbidden"):
        fail("LIGHTING_PREVIEW must be export-forbidden")
    if not CHECKPOINT_PATH.exists() or CHECKPOINT_PATH.stat().st_size == 0:
        fail("A0 checkpoint is missing or empty")

    print("ES7 ANIMATION MASTER VALIDATION PASS")
    print(f"- source/work objects: {len(source_objects)}/{len(work_objects)}")
    print(f"- source/work meshes: {len(source_meshes)}/{len(work_meshes)}")
    print(f"- source/work triangles: {source_triangles}/{work_triangles}")
    print(f"- normalized wheelbase: {measured_wheelbase:.6f} m")
    print(f"- cameras: {len(camera_names)}")
    print(f"- checkpoint bytes: {CHECKPOINT_PATH.stat().st_size}")


if __name__ == "__main__":
    main()
