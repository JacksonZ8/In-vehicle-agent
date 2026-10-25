#!/usr/bin/env python3
"""Align extracted ES7 emissive surfaces with the outer source lamp lenses."""

from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
WORLD_OFFSETS = {
    "front_drl_left": (0.08, 0.0, 0.0),
    "front_drl_right": (0.08, 0.0, 0.0),
    "low_beam_left": (0.12, 0.0, 0.0),
    "low_beam_right": (0.12, 0.0, 0.0),
    "indicator_front_left": (0.0, 0.02, 0.0),
    "indicator_front_right": (0.0, -0.02, 0.0),
    "rear_tail_left": (-0.04, 0.0, 0.0),
    "rear_tail_right": (-0.04, 0.0, 0.0),
    "indicator_rear_left": (-0.04, 0.0, 0.0),
    "indicator_rear_right": (-0.04, 0.0, 0.0),
    "rear_tail_tailgate_left": (-0.19, 0.0, 0.0),
    "rear_tail_tailgate_right": (-0.19, 0.0, 0.0),
    "indicator_tailgate_left": (-0.18, 0.0, 0.0),
    "indicator_tailgate_right": (-0.18, 0.0, 0.0),
    "rear_center_brake": (0.0, 0.0, 0.0),
}


def fail(message):
    raise SystemExit(f"ES7 LIGHT/LENS ALIGNMENT FAILED: {message}")


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before aligning light surfaces")
    for component_id, values in WORLD_OFFSETS.items():
        meshes = [
            obj for obj in bpy.data.objects
            if obj.type == "MESH" and obj.get("component_id") == component_id
            and obj.get("light_control")
        ]
        if len(meshes) != 1:
            fail(f"expected one semantic mesh for {component_id}, found {len(meshes)}")
        obj = meshes[0]
        if obj.get("light_lens_alignment_world_m") is not None:
            fail(f"{component_id} has already been aligned")
        world_offset = Vector(values)
        local_offset = obj.matrix_world.to_3x3().inverted() @ world_offset
        for vertex in obj.data.vertices:
            vertex.co += local_offset
        obj.data.update()
        obj["light_lens_alignment_world_m"] = list(world_offset)
        obj["light_lens_alignment_basis"] = "audited-inner-surface-to-outer-lens-bounds"
    bpy.context.scene["es7_light_lens_alignment"] = "audited-world-offsets-v1"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))
    print("ES7 LIGHT/LENS ALIGNMENT PASS")
    print(f"- aligned semantic meshes: {len(WORLD_OFFSETS)}")


if __name__ == "__main__":
    main()
