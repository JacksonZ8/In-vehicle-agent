#!/usr/bin/env python3
"""Validate the extracted ES7 hood geometry and hinge pivot."""

import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import objects_world_bounds as world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-hood-extraction.blend"
HOOD_OBJECT_NAMES = ("hood_mesh_left", "hood_mesh_right")


def fail(message):
    raise SystemExit(f"ES7 HOOD VALIDATION FAILED: {message}")


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validation")
    pivot = bpy.data.objects.get("hood_pivot")
    vehicle_root = bpy.data.objects.get("vehicle_root")
    if not pivot or pivot.parent != vehicle_root:
        fail("hood_pivot is missing or mis-parented")
    if pivot.get("hinge_axis") != "Y" or pivot.get("component_id") != "hood":
        fail("hood_pivot semantics are incorrect")

    hood_objects = []
    total_polygons = 0
    total_triangles = 0
    for name in HOOD_OBJECT_NAMES:
        obj = bpy.data.objects.get(name)
        if not obj or obj.type != "MESH" or obj.parent != pivot:
            fail(f"missing or mis-parented {name}")
        if obj.get("component_id") != "hood":
            fail(f"{name} component id is incorrect")
        if len(obj.data.vertices) != 594 or len(obj.data.polygons) != 1088:
            fail(f"{name} geometry count changed")
        obj.data.calc_loop_triangles()
        total_polygons += len(obj.data.polygons)
        total_triangles += len(obj.data.loop_triangles)
        hood_objects.append(obj)

    minimum, maximum = world_bounds(hood_objects)
    if not (minimum.x > 1.1 and maximum.x > 2.4 and maximum.z > 1.25):
        fail(f"hood bounds are implausible: {list(minimum)} / {list(maximum)}")
    if abs((minimum.y + maximum.y) * 0.5) > 1e-4:
        fail("hood halves are not centered around vehicle Y=0")
    if not CHECKPOINT_PATH.exists() or CHECKPOINT_PATH.stat().st_size == 0:
        fail("pre-hood checkpoint is missing")
    marker = bpy.data.objects.get("ES7_STAGE_A1_HOOD_RIG")
    if not marker or marker.get("status") != "hood-islands-extracted-and-rigged":
        fail("hood stage marker is missing")

    print("ES7 HOOD VALIDATION PASS")
    print(f"- hood polygons: {total_polygons}")
    print(f"- hood triangles: {total_triangles}")
    print(f"- bounds min/max: {[round(value, 6) for value in minimum]} / {[round(value, 6) for value in maximum]}")
    print(f"- checkpoint bytes: {CHECKPOINT_PATH.stat().st_size}")


if __name__ == "__main__":
    main()
