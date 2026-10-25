#!/usr/bin/env python3
"""Validate the applied ES7 rigid-wiper windshield contact contract."""

import json
import statistics
import sys
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import WIPER_REVIEW_KEYFRAMES


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
AUDIT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "wiper-glass-contact-audit.json"
GLASS_NAME = "es7_work__ES7_Glass1"
MARKER_NAME = "ES7_WIPER_CONTACT_PLANE_CALIBRATION"
FRAMES = WIPER_REVIEW_KEYFRAMES
MAXIMUM_GAPS = {"left": 0.008, "right": 0.012}
PENETRATION_TOLERANCE = 0.00005
OUTWARD_AXIS = Vector((1.0, 0.0, 0.0))
EXPECTED_ORIGINS = {
    "left": Vector((1.2165, 0.6922, 1.1930)),
    "right": Vector((1.277216, -0.136966, 1.246273)),
}


def fail(message):
    raise SystemExit(f"ES7 WIPER GLASS-CONTACT VALIDATION FAILED: {message}")


def world_bvh(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    vertices = [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
    triangles = [tuple(loop.vertices) for loop in mesh.loop_triangles]
    return BVHTree.FromPolygons(vertices, triangles, all_triangles=True)


def signed_gap(tree, point):
    location, normal, _face_index, _distance = tree.find_nearest(point)
    if location is None or normal is None:
        fail("windshield BVH did not return a nearest surface")
    normal = normal.normalized()
    if normal.dot(OUTWARD_AXIS) < 0.0:
        normal.negate()
    return float((point - location).dot(normal))


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validating")
    marker = bpy.data.objects.get(MARKER_NAME)
    if marker is None or marker.get("status") != "independent-rigid-wiper-contact-planes":
        fail("contact-plane calibration marker is missing")
    if abs(float(marker.get("left_maximum_gap_meters", -1.0)) - MAXIMUM_GAPS["left"]) > 1e-9:
        fail("left maximum-gap marker differs from the approved contract")
    if abs(float(marker.get("right_maximum_gap_meters", -1.0)) - MAXIMUM_GAPS["right"]) > 1e-9:
        fail("right maximum-gap marker differs from the approved contract")

    audit = json.loads(AUDIT_PATH.read_text(encoding="utf-8"))
    glass = bpy.data.objects.get(GLASS_NAME)
    if glass is None or glass.type != "MESH":
        fail(f"missing windshield mesh {GLASS_NAME}")
    tree = world_bvh(glass)
    scene = bpy.context.scene
    centers = {side: {} for side in EXPECTED_ORIGINS}

    for progress, frame in FRAMES.items():
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        for side, origin in EXPECTED_ORIGINS.items():
            pivot = bpy.data.objects.get(f"wiper_{side}_pivot")
            object_name = audit["wipers"][side]["object"]
            obj = bpy.data.objects.get(object_name)
            if pivot is None or obj is None or obj.parent != pivot:
                fail(f"missing or incorrectly parented {side} wiper")
            if (pivot.matrix_world.translation - origin).length > 0.0001:
                fail(f"{side} spindle origin moved at {progress}%")
            gaps = [
                signed_gap(tree, obj.matrix_world @ obj.data.vertices[index].co)
                for index in audit["wipers"][side]["sampleVertices"]
            ]
            if min(gaps) < -PENETRATION_TOLERANCE:
                fail(f"{side} wiper penetrates the windshield at {progress}%: {min(gaps):.6f} m")
            if max(gaps) > MAXIMUM_GAPS[side] + 1e-6:
                fail(f"{side} wiper exceeds the contact gap at {progress}%: {max(gaps):.6f} m")
            centers[side][progress] = sum(
                (obj.matrix_world @ Vector(corner) for corner in obj.bound_box), Vector()
            ) / 8.0
            print(
                f"- {side} {progress}%: min/median/max="
                f"{min(gaps):.4f}/{statistics.median(gaps):.4f}/{max(gaps):.4f} m"
            )

    for side in EXPECTED_ORIGINS:
        if (centers[side]["100"] - centers[side]["0"]).length > 0.0001:
            fail(f"{side} wiper does not return to its rest position")

    print("ES7 WIPER GLASS-CONTACT VALIDATION PASS")
    print("- maximum gaps left/right: 0.008/0.012 m")
    print("- spindle drift and return error: <= 0.0001 m")


if __name__ == "__main__":
    main()
