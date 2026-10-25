#!/usr/bin/env python3
"""Move the existing Stage-B charge pivot to the cover hinge without moving closed geometry."""

import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
PIVOT_NAME = "charge_port_pivot"
MESH_NAME = "charge_port_mesh"
MARKER_NAME = "ES7_STAGE_B_CHARGE_PIVOT_CORRECTION"


def fail(message):
    raise SystemExit(f"ES7 CHARGE-PIVOT CORRECTION FAILED: {message}")


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before correction")
    if bpy.data.objects.get(MARKER_NAME):
        fail("charge-port pivot correction has already been applied")
    scene = bpy.context.scene
    scene.frame_set(1)
    bpy.context.view_layer.update()
    pivot = bpy.data.objects.get(PIVOT_NAME)
    mesh = bpy.data.objects.get(MESH_NAME)
    if not pivot or not mesh or mesh.parent != pivot:
        fail("charge-port pivot/mesh hierarchy is missing")
    minimum, maximum = world_bounds(mesh)
    center = (minimum + maximum) * 0.5
    desired_origin = Vector((maximum.x, center.y, center.z))
    child_world_matrices = {child: child.matrix_world.copy() for child in pivot.children}
    matrix_world = pivot.matrix_world.copy()
    previous_origin = matrix_world.translation.copy()
    matrix_world.translation = desired_origin
    pivot.matrix_world = matrix_world
    bpy.context.view_layer.update()
    for child, child_world in child_world_matrices.items():
        child.matrix_world = child_world
    bpy.context.view_layer.update()
    pivot["stage_b_corrected_hinge_origin"] = [round(float(value), 6) for value in desired_origin]

    marker = bpy.data.objects.new(MARKER_NAME, None)
    marker["previous_origin"] = [round(float(value), 6) for value in previous_origin]
    marker["corrected_origin"] = [round(float(value), 6) for value in desired_origin]
    marker["reason"] = "pivot was positioned before collection linking and evaluated at the source origin"
    bpy.data.collections["RIG_COMPONENTS"].objects.link(marker)
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))

    print("ES7 CHARGE-PIVOT CORRECTION PASS")
    print(f"- previous origin: {tuple(round(value, 4) for value in previous_origin)}")
    print(f"- corrected origin: {tuple(round(value, 4) for value in desired_origin)}")
    print("- closed charge-port geometry preserved")


if __name__ == "__main__":
    main()
