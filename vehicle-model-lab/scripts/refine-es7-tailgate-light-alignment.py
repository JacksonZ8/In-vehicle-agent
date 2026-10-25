#!/usr/bin/env python3
"""Refine tailgate lamp alignment from lens-extreme to lens-center offsets."""

from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CORRECTIONS = {
    "rear_tail_tailgate_left": (0.15, 0.0, 0.0),
    "rear_tail_tailgate_right": (0.15, 0.0, 0.0),
    "indicator_tailgate_left": (0.14, 0.0, 0.0),
    "indicator_tailgate_right": (0.14, 0.0, 0.0),
}
FINAL_WORLD_OFFSET = (-0.04, 0.0, 0.0)


def fail(message):
    raise SystemExit(f"ES7 TAILGATE LIGHT REFINEMENT FAILED: {message}")


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before refining tailgate lights")
    for component_id, correction_values in CORRECTIONS.items():
        meshes = [
            obj for obj in bpy.data.objects
            if obj.type == "MESH" and obj.get("component_id") == component_id
            and obj.get("light_control")
        ]
        if len(meshes) != 1:
            fail(f"expected one semantic mesh for {component_id}, found {len(meshes)}")
        obj = meshes[0]
        if obj.get("tailgate_light_alignment_refined"):
            fail(f"{component_id} has already been refined")
        world_correction = Vector(correction_values)
        local_correction = obj.matrix_world.to_3x3().inverted() @ world_correction
        for vertex in obj.data.vertices:
            vertex.co += local_correction
        obj.data.update()
        obj["light_lens_alignment_world_m"] = list(FINAL_WORLD_OFFSET)
        obj["tailgate_light_alignment_refined"] = True
        obj["tailgate_light_alignment_basis"] = "outer-lens-center-difference"
    bpy.context.scene["es7_tailgate_light_alignment"] = "center-offset-minus-0.04m"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))
    print("ES7 TAILGATE LIGHT REFINEMENT PASS")
    print(f"- refined semantic meshes: {len(CORRECTIONS)}")
    print("- final world X offset: -0.04 m")


if __name__ == "__main__":
    main()
