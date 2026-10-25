#!/usr/bin/env python3
"""Shift hood suspension curves to the corrected hinge height and persist the closed pose."""

import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import objects_world_bounds as world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
MARKER_NAME = "ES7_HOOD_SUSPENSION_CURVE_REPAIR"
HOOD_PAIRS = (
    ("hood_mesh_left", "es7_work__ES7_Body_L"),
    ("hood_mesh_right", "es7_work__ES7_Body_R"),
)


def fail(message):
    raise SystemExit(f"ES7 HOOD SUSPENSION-CURVE REPAIR FAILED: {message}")


def action_fcurves(action):
    for layer in action.layers:
        for strip in layer.strips:
            for channelbag in strip.channelbags:
                yield from channelbag.fcurves


def shift_curve(curve, delta):
    for keyframe in curve.keyframe_points:
        keyframe.co[1] += delta
        keyframe.handle_left[1] += delta
        keyframe.handle_right[1] += delta
    curve.update()


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before curve repair")
    if bpy.data.objects.get(MARKER_NAME):
        fail("hood suspension-curve repair has already been applied")
    pivot = bpy.data.objects.get("hood_pivot")
    if not pivot or not pivot.parent or not pivot.animation_data:
        fail("hood pivot animation hierarchy is missing")
    hoods = []
    closed_world_matrices = {}
    for hood_name, body_name in HOOD_PAIRS:
        hood = bpy.data.objects.get(hood_name)
        body = bpy.data.objects.get(body_name)
        if not hood or not body or hood.parent != pivot:
            fail(f"hood/body pair is missing: {hood_name}/{body_name}")
        hoods.append(hood)
        closed_world_matrices[hood] = body.matrix_world.copy()

    scene = bpy.context.scene
    scene.frame_set(251)
    bpy.context.view_layer.update()
    for hood, matrix_world in closed_world_matrices.items():
        hood.matrix_world = matrix_world
    bpy.context.view_layer.update()
    minimum, maximum = world_bounds(hoods)
    desired_origin = Vector((minimum.x + 0.015, 0.0, maximum.z - 0.02))
    current_origin = pivot.matrix_world.translation.copy()
    delta_z = desired_origin.z - current_origin.z

    shifted_actions = []
    seen_actions = set()
    for track in pivot.animation_data.nla_tracks:
        for strip in track.strips:
            action = strip.action
            if not action or action in seen_actions:
                continue
            seen_actions.add(action)
            curves = [
                curve for curve in action_fcurves(action)
                if curve.data_path == "location" and curve.array_index == 2
            ]
            for curve in curves:
                shift_curve(curve, delta_z)
                shifted_actions.append(action.name)
    if len(shifted_actions) != 2:
        fail(f"expected 2 hood suspension Z curves, shifted {shifted_actions}")

    pivot.matrix_parent_inverse = Matrix.Identity(4)
    pivot.location.z += delta_z
    scene.frame_set(251)
    bpy.context.view_layer.update()
    if (pivot.matrix_world.translation - desired_origin).length > 1e-4:
        fail(f"shifted suspension curves did not produce the desired hinge: {tuple(pivot.matrix_world.translation)}")
    for hood, matrix_world in closed_world_matrices.items():
        hood.matrix_parent_inverse = Matrix.Identity(4)
        hood.matrix_basis = pivot.matrix_world.inverted() @ matrix_world
    bpy.context.view_layer.update()
    restored_bounds = world_bounds(hoods)
    if (restored_bounds[0] - minimum).length > 1e-5 or (restored_bounds[1] - maximum).length > 1e-5:
        fail("hood closed bounds changed while persisting the child transforms")

    marker = bpy.data.objects.new(MARKER_NAME, None)
    marker["status"] = "hood-suspension-curves-shifted-to-corrected-hinge"
    marker["delta_z"] = round(float(delta_z), 6)
    marker["shifted_actions"] = shifted_actions
    bpy.data.collections["RIG_COMPONENTS"].objects.link(marker)
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))

    print("ES7 HOOD SUSPENSION-CURVE REPAIR PASS")
    print(f"- shifted Z: {delta_z:.6f} m")
    print(f"- shifted actions: {shifted_actions}")
    print(f"- hinge world origin: {tuple(round(value, 4) for value in desired_origin)}")
    print(f"- closed bounds: {tuple(round(value, 4) for value in (*minimum, *maximum))}")


if __name__ == "__main__":
    main()
