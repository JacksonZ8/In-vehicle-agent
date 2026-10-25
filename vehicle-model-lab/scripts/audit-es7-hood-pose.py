#!/usr/bin/env python3
"""Print ES7 hood pivot and mesh world poses at closed/open review frames."""

import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import objects_world_bounds as world_bounds


def values(vector):
    return tuple(round(float(value), 5) for value in vector)


def main():
    pivot = bpy.data.objects.get("hood_pivot")
    hoods = [bpy.data.objects.get("hood_mesh_left"), bpy.data.objects.get("hood_mesh_right")]
    if not pivot or any(obj is None for obj in hoods):
        raise SystemExit("hood rig is missing")
    print(f"ES7 HOOD POSE AUDIT: {bpy.data.filepath}")
    for frame in (1, 251, 281, 310):
        bpy.context.scene.frame_set(frame)
        bpy.context.view_layer.update()
        minimum, maximum = world_bounds(hoods)
        center = (minimum + maximum) * 0.5
        print(
            f"- frame={frame} pivot_world={values(pivot.matrix_world.translation)} "
            f"pivot_location={values(pivot.location)} pivot_rotation={values(pivot.rotation_euler)} "
            f"parent_world={values(pivot.parent.matrix_world.translation) if pivot.parent else '-'} "
            f"bounds={values((*minimum, *maximum))} "
            f"center={values(center)}"
        )
    for hood in hoods:
        print(f"- {hood.name} matrix_world={[round(value, 6) for row in hood.matrix_world for value in row]}")
    if pivot.animation_data:
        print("- animation tracks:")
        for track in pivot.animation_data.nla_tracks:
            for strip in track.strips:
                paths = []
                if strip.action:
                    for layer in strip.action.layers:
                        for action_strip in layer.strips:
                            for channelbag in action_strip.channelbags:
                                paths.extend(f"{curve.data_path}[{curve.array_index}]" for curve in channelbag.fcurves)
                print(
                    f"  {track.name} mute={track.mute} strip={strip.name} "
                    f"blend={strip.blend_type} paths={paths}"
                )


if __name__ == "__main__":
    main()
