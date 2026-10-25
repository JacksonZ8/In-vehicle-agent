#!/usr/bin/env python3
"""List visible mesh objects overlapping each controlled ES7 wheel volume."""

import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
WHEEL_NAMES = (
    "wheel_mesh_front_left",
    "wheel_mesh_front_right",
    "wheel_mesh_rear_left",
    "wheel_mesh_rear_right",
)


def overlaps(left, right, padding=0.03):
    return all(
        left[0][axis] - padding <= right[1][axis]
        and right[0][axis] - padding <= left[1][axis]
        for axis in range(3)
    )


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        raise SystemExit(f"open {MASTER_PATH} before auditing")
    scene = bpy.context.scene
    scene.frame_set(1)
    bpy.context.view_layer.update()
    visible_meshes = [
        obj for obj in bpy.data.objects
        if obj.type == "MESH" and not obj.hide_render and not obj.hide_viewport
    ]
    print("ES7 WHEEL OVERLAP AUDIT")
    for name in WHEEL_NAMES:
        wheel = bpy.data.objects.get(name)
        if not wheel:
            raise SystemExit(f"missing {name}")
        wheel_bounds = world_bounds(wheel)
        print(f"\n{name} bounds={tuple(round(value, 4) for value in (*wheel_bounds[0], *wheel_bounds[1]))}")
        for obj in visible_meshes:
            obj_bounds = world_bounds(obj)
            if not overlaps(wheel_bounds, obj_bounds):
                continue
            materials = sorted({slot.material.name for slot in obj.material_slots if slot.material})
            collections = sorted(collection.name for collection in obj.users_collection)
            print(
                f"- {obj.name} parent={obj.parent.name if obj.parent else '-'} "
                f"verts={len(obj.data.vertices)} forbidden={bool(obj.get('export_forbidden'))} "
                f"source={obj.get('source_object_name', '-')} "
                f"bounds={tuple(round(value, 4) for value in (*obj_bounds[0], *obj_bounds[1]))} "
                f"collections={collections} materials={materials}"
            )
    print("\nVISIBLE TIRE-MATERIAL MESHES")
    for obj in visible_meshes:
        materials = sorted({slot.material.name for slot in obj.material_slots if slot.material})
        if not any("轮面" in name for name in materials):
            continue
        obj_bounds = world_bounds(obj)
        print(
            f"- {obj.name} parent={obj.parent.name if obj.parent else '-'} "
            f"verts={len(obj.data.vertices)} source={obj.get('source_object_name', '-')} "
            f"bounds={tuple(round(value, 4) for value in (*obj_bounds[0], *obj_bounds[1]))} "
            f"materials={materials}"
        )


if __name__ == "__main__":
    main()
