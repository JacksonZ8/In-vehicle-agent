#!/usr/bin/env python3
"""Move semantic lamp surfaces slightly outward so source lenses do not occlude emission."""

from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OFFSET_METERS = 0.003


def fail(message):
    raise SystemExit(f"ES7 LIGHT SURFACE OFFSET FAILED: {message}")


def outward_sign(obj):
    world_matrix = obj.matrix_world
    normal_matrix = world_matrix.to_3x3()
    score = 0.0
    for vertex in obj.data.vertices:
        world_point = world_matrix @ vertex.co
        radial = Vector((world_point.x, world_point.y, world_point.z - 0.75))
        world_normal = (normal_matrix @ vertex.normal).normalized()
        score += world_normal.dot(radial)
    return 1.0 if score >= 0.0 else -1.0


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before offsetting light surfaces")
    light_meshes = [
        obj for obj in bpy.data.objects
        if obj.type == "MESH" and obj.get("light_control") and obj.get("material_semantic")
    ]
    if len(light_meshes) != 15:
        fail(f"expected 15 semantic light meshes, found {len(light_meshes)}")
    for obj in light_meshes:
        if obj.get("light_surface_offset_m") is not None:
            fail(f"{obj.name} has already been offset")
        obj.data.update()
        scale = sum(abs(value) for value in obj.matrix_world.to_scale()) / 3.0
        if scale <= 0.0:
            fail(f"{obj.name} has invalid world scale")
        local_distance = OFFSET_METERS / scale
        direction = outward_sign(obj)
        for vertex in obj.data.vertices:
            vertex.co += vertex.normal.normalized() * local_distance * direction
        obj.data.update()
        obj["light_surface_offset_m"] = OFFSET_METERS
        obj["light_surface_offset_direction"] = "outward-from-vehicle-center"
    bpy.context.scene["es7_light_surface_offset_m"] = OFFSET_METERS
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))
    print("ES7 LIGHT SURFACE OFFSET PASS")
    print(f"- semantic light meshes: {len(light_meshes)}")
    print(f"- outward offset: {OFFSET_METERS} m")


if __name__ == "__main__":
    main()
