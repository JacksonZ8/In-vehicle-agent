#!/usr/bin/env python3
"""Solve and optionally apply independent ES7 wiper contact-plane orientations."""

import filecmp
import json
import math
import os
import shutil
import statistics
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import WIPER_REVIEW_KEYFRAMES


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-wiper-contact-plane-calibration.blend"
AUDIT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "wiper-glass-contact-audit.json"
OUTPUT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "wiper-contact-plane-calibration.json"
DRY_RUN_OUTPUT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "working" / "wiper-contact-plane-calibration.dry-run.json"
GLASS_NAME = "es7_work__ES7_Glass1"
PIVOTS = {"left": "wiper_left_pivot", "right": "wiper_right_pivot"}
FRAMES = WIPER_REVIEW_KEYFRAMES
MOTION_PROGRESS = ("25", "50", "75")
OUTWARD_AXIS = Vector((1.0, 0.0, 0.0))
TARGET_GAP = 0.003
MAXIMUM_GAPS = {"left": 0.008, "right": 0.012}
PENETRATION_TOLERANCE = 0.00005
COARSE_LIMIT = 0.70
COARSE_STEP = 0.035
FINE_LIMIT = 0.055
FINE_STEP = 0.005
MARKER_NAME = "ES7_WIPER_CONTACT_PLANE_CALIBRATION"


def fail(message):
    raise SystemExit(f"ES7 WIPER CONTACT-PLANE CALIBRATION FAILED: {message}")


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def rounded(values, digits=8):
    return [round(float(value), digits) for value in values]


def matrix_rows(matrix):
    return [rounded(row) for row in matrix]


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


def values(start, stop, step):
    count = round((stop - start) / step)
    return [start + index * step for index in range(count + 1)]


def candidate_rotation(base_rotation, tilt_u_axis, tilt_v_axis, tilt_u, tilt_v):
    return (
        Matrix.Rotation(tilt_u, 3, tilt_u_axis)
        @ Matrix.Rotation(tilt_v, 3, tilt_v_axis)
        @ base_rotation
    )


def evaluate_candidate(
    tree, origin, base_rotation, tilt_u_axis, tilt_v_axis,
    rest_points, angles, tilt_u, tilt_v, maximum_gap,
):
    rest_rotation = candidate_rotation(base_rotation, tilt_u_axis, tilt_v_axis, tilt_u, tilt_v)
    rest_inverse = rest_rotation.inverted()
    per_frame = {}
    all_motion_gaps = []
    for progress, angle in angles.items():
        animated_rotation = rest_rotation @ Matrix.Rotation(angle, 3, "Z")
        transform = animated_rotation @ rest_inverse
        gaps = [signed_gap(tree, origin + transform @ (point - origin)) for point in rest_points]
        per_frame[progress] = gaps
        if progress in MOTION_PROGRESS:
            all_motion_gaps.extend(gaps)
    minimum = min(all_motion_gaps)
    maximum = max(all_motion_gaps)
    target_error = math.sqrt(sum((gap - TARGET_GAP) ** 2 for gap in all_motion_gaps) / len(all_motion_gaps))
    penetration = max(0.0, -minimum - PENETRATION_TOLERANCE)
    excess = max(0.0, maximum - maximum_gap)
    hard_penalty = penetration * 10000.0 + excess * 5000.0
    angle_penalty = math.sqrt(tilt_u * tilt_u + tilt_v * tilt_v) * 0.00005
    return {
        "tiltU": tilt_u,
        "tiltV": tilt_v,
        "minimum": minimum,
        "maximum": maximum,
        "median": statistics.median(all_motion_gaps),
        "targetError": target_error,
        "score": hard_penalty + target_error + angle_penalty,
        "feasible": penetration == 0.0 and excess == 0.0,
        "perFrame": per_frame,
    }


def search_side(tree, origin, base_rotation, tilt_u_axis, tilt_v_axis, rest_points, angles, maximum_gap):
    best = None
    for delta_x in values(-COARSE_LIMIT, COARSE_LIMIT, COARSE_STEP):
        for delta_y in values(-COARSE_LIMIT, COARSE_LIMIT, COARSE_STEP):
            candidate = evaluate_candidate(
                tree, origin, base_rotation, tilt_u_axis, tilt_v_axis,
                rest_points, angles, delta_x, delta_y, maximum_gap,
            )
            if best is None or candidate["score"] < best["score"]:
                best = candidate
    coarse = best
    for tilt_u in values(coarse["tiltU"] - FINE_LIMIT, coarse["tiltU"] + FINE_LIMIT, FINE_STEP):
        for tilt_v in values(coarse["tiltV"] - FINE_LIMIT, coarse["tiltV"] + FINE_LIMIT, FINE_STEP):
            candidate = evaluate_candidate(
                tree, origin, base_rotation, tilt_u_axis, tilt_v_axis,
                rest_points, angles, tilt_u, tilt_v, maximum_gap,
            )
            if candidate["score"] < best["score"]:
                best = candidate
    return best


def stats(values_):
    return {
        "minimumMeters": round(min(values_), 6),
        "medianMeters": round(statistics.median(values_), 6),
        "maximumMeters": round(max(values_), 6),
        "penetratingSamples": sum(value < -PENETRATION_TOLERANCE for value in values_),
    }


def candidate_report(candidate, base_rotation, tilt_u_axis, tilt_v_axis):
    rest_rotation = candidate_rotation(
        base_rotation, tilt_u_axis, tilt_v_axis,
        candidate["tiltU"], candidate["tiltV"],
    )
    return {
        "feasible": candidate["feasible"],
        "axisTiltRadians": [round(candidate["tiltU"], 8), round(candidate["tiltV"], 8)],
        "tiltBasisWorld": [rounded(tilt_u_axis), rounded(tilt_v_axis)],
        "worldRotation": matrix_rows(rest_rotation),
        "worldAxis": rounded(rest_rotation @ Vector((0.0, 0.0, 1.0))),
        "motionStatistics": {
            "minimumMeters": round(candidate["minimum"], 6),
            "medianMeters": round(candidate["median"], 6),
            "maximumMeters": round(candidate["maximum"], 6),
            "targetRmsErrorMeters": round(candidate["targetError"], 6),
        },
        "keyframes": {progress: stats(gaps) for progress, gaps in candidate["perFrame"].items()},
        "sampleGapsMeters": {
            progress: [round(value, 6) for value in gaps]
            for progress, gaps in candidate["perFrame"].items()
        },
    }


def preserve_checkpoint():
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if CHECKPOINT_PATH.exists():
        if not filecmp.cmp(MASTER_PATH, CHECKPOINT_PATH, shallow=False):
            fail(f"checkpoint exists but does not match the current pre-calibration master: {CHECKPOINT_PATH}")
        return
    shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)


def apply_candidate(side, pivot, candidate_world_rotation):
    child_matrices = {child: child.matrix_world.copy() for child in pivot.children}
    origin = pivot.matrix_world.translation.copy()
    desired_world = candidate_world_rotation.to_4x4()
    desired_world.translation = origin
    parent_world = pivot.parent.matrix_world.copy()
    basis = pivot.matrix_basis.copy()
    pivot.matrix_parent_inverse = parent_world.inverted() @ desired_world @ basis.inverted()
    bpy.context.view_layer.update()
    if (pivot.matrix_world.translation - origin).length > 0.0001:
        fail(f"{side} pivot origin moved while applying the contact plane")
    for child, matrix_world in child_matrices.items():
        child.matrix_world = matrix_world
    bpy.context.view_layer.update()


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before calibrating")
    if not AUDIT_PATH.exists():
        fail(f"missing contact audit {AUDIT_PATH}")
    apply_mode = os.environ.get("ES7_WIPER_CONTACT_APPLY") == "1"
    if apply_mode and bpy.data.objects.get(MARKER_NAME):
        fail("contact-plane calibration has already been applied")

    audit = load_json(AUDIT_PATH)
    glass = bpy.data.objects.get(GLASS_NAME)
    if glass is None or glass.type != "MESH":
        fail(f"missing windshield mesh {GLASS_NAME}")
    tree = world_bvh(glass)
    scene = bpy.context.scene

    pivots = {}
    objects = {}
    angles = {side: {} for side in PIVOTS}
    for progress, frame in FRAMES.items():
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        for side, pivot_name in PIVOTS.items():
            pivot = bpy.data.objects.get(pivot_name)
            if pivot is None or pivot.parent is None:
                fail(f"missing {side} pivot or parent")
            pivots[side] = pivot
            angles[side][progress] = float(pivot.rotation_euler.z)

    scene.frame_set(FRAMES["0"])
    bpy.context.view_layer.update()
    results = {}
    candidates = {}
    for side, pivot in pivots.items():
        object_name = audit["wipers"][side]["object"]
        obj = bpy.data.objects.get(object_name)
        if obj is None or obj.type != "MESH":
            fail(f"missing audited blade object {object_name}")
        objects[side] = obj
        sample_indices = audit["wipers"][side]["sampleVertices"]
        rest_points = [obj.matrix_world @ obj.data.vertices[index].co for index in sample_indices]
        base_rotation = pivot.matrix_world.to_3x3().normalized()
        base_axis = (base_rotation @ Vector((0.0, 0.0, 1.0))).normalized()
        reference = Vector((0.0, 1.0, 0.0))
        if abs(base_axis.dot(reference)) > 0.95:
            reference = Vector((1.0, 0.0, 0.0))
        tilt_u_axis = base_axis.cross(reference).normalized()
        tilt_v_axis = base_axis.cross(tilt_u_axis).normalized()
        candidate = search_side(
            tree,
            pivot.matrix_world.translation.copy(),
            base_rotation,
            tilt_u_axis,
            tilt_v_axis,
            rest_points,
            angles[side],
            MAXIMUM_GAPS[side],
        )
        candidates[side] = candidate
        results[side] = {
            "pivot": pivot.name,
            "origin": rounded(pivot.matrix_world.translation),
            "baseWorldRotation": matrix_rows(base_rotation),
            "baseWorldAxis": rounded(base_axis),
            "anglesByProgress": {progress: round(value, 8) for progress, value in angles[side].items()},
            "sampleVertices": sample_indices,
            "candidate": candidate_report(candidate, base_rotation, tilt_u_axis, tilt_v_axis),
        }

    feasible = all(candidate["feasible"] for candidate in candidates.values())
    report = {
        "contract": "nio-es7-wiper-contact-plane-calibration@0.1.0",
        "source": "source/nio-es7-animation-master.blend",
        "mode": "apply" if apply_mode else "dry-run",
        "constraints": {
            "targetGapMeters": TARGET_GAP,
            "maximumGapMetersBySide": MAXIMUM_GAPS,
            "penetrationToleranceMeters": PENETRATION_TOLERANCE,
            "fixedOrigins": True,
            "rigidAssemblies": True,
        },
        "feasible": feasible,
        "wipers": results,
    }
    report_path = OUTPUT_PATH if apply_mode else DRY_RUN_OUTPUT_PATH
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"ES7 WIPER CONTACT-PLANE CALIBRATION {'FEASIBLE' if feasible else 'INFEASIBLE'} ({report['mode']})")
    for side in ("left", "right"):
        item = results[side]["candidate"]
        motion = item["motionStatistics"]
        print(
            f"- {side}: axisTilts={tuple(item['axisTiltRadians'])}, "
            f"min/median/max={motion['minimumMeters']:.4f}/"
            f"{motion['medianMeters']:.4f}/{motion['maximumMeters']:.4f} m"
        )
    print(f"- report: {report_path}")

    if not apply_mode:
        return
    if not feasible:
        fail("no rigid fixed-origin candidate satisfies the approved contact constraints")
    preserve_checkpoint()
    scene.frame_set(FRAMES["0"])
    bpy.context.view_layer.update()
    for side, pivot in pivots.items():
        world_rotation = Matrix(results[side]["candidate"]["worldRotation"])
        apply_candidate(side, pivot, world_rotation)

    marker = bpy.data.objects.new(MARKER_NAME, None)
    marker["status"] = "independent-rigid-wiper-contact-planes"
    marker["contract"] = report["contract"]
    marker["left_world_rotation"] = [value for row in results["left"]["candidate"]["worldRotation"] for value in row]
    marker["right_world_rotation"] = [value for row in results["right"]["candidate"]["worldRotation"] for value in row]
    marker["left_maximum_gap_meters"] = MAXIMUM_GAPS["left"]
    marker["right_maximum_gap_meters"] = MAXIMUM_GAPS["right"]
    marker["checkpoint"] = str(CHECKPOINT_PATH.relative_to(LAB_ROOT))
    bpy.data.collections["RIG_COMPONENTS"].objects.link(marker)
    scene["es7_wiper_contact_planes"] = "independent-rigid-tangent-planes"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))
    print(f"ES7 WIPER CONTACT-PLANE CALIBRATION APPLIED: {MASTER_PATH}")
    print(f"- checkpoint: {CHECKPOINT_PATH}")


if __name__ == "__main__":
    main()
