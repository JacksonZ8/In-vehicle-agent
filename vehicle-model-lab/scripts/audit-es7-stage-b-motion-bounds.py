#!/usr/bin/env python3
"""Report Stage-B moving-mesh world centers at closed and review-open frames."""

from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SAMPLES = {
    "charge_port_mesh": (501, 526),
    "mirror_left_mesh": (551, 576),
    "mirror_right_mesh": (551, 576),
    "wiper_left_mesh": (601, 636),
    "wiper_right_mesh": (601, 636),
}


def world_center(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return (minimum + maximum) * 0.5


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        raise SystemExit(f"open {MASTER_PATH} before auditing")
    scene = bpy.context.scene
    print("ES7 STAGE-B MOTION BOUNDS")
    results = {}
    for name, (closed_frame, open_frame) in SAMPLES.items():
        obj = bpy.data.objects[name]
        pivot = obj.parent
        scene.frame_set(closed_frame)
        bpy.context.view_layer.update()
        closed = world_center(obj)
        pivot_closed = pivot.matrix_world.translation.copy()
        origin_closed = obj.matrix_world.translation.copy()
        scene.frame_set(open_frame)
        bpy.context.view_layer.update()
        opened = world_center(obj)
        pivot_open = pivot.matrix_world.translation.copy()
        origin_open = obj.matrix_world.translation.copy()
        delta = opened - closed
        results[name] = delta
        print(
            f"- {name}: closed={tuple(round(value, 4) for value in closed)} "
            f"open={tuple(round(value, 4) for value in opened)} "
            f"delta={tuple(round(value, 4) for value in delta)} length={delta.length:.4f}"
        )
        print(
            f"  pivot={tuple(round(value, 4) for value in pivot_closed)}->"
            f"{tuple(round(value, 4) for value in pivot_open)} origin="
            f"{tuple(round(value, 4) for value in origin_closed)}->"
            f"{tuple(round(value, 4) for value in origin_open)}"
        )
    charge_delta = results["charge_port_mesh"]
    if charge_delta.length > 0.2 or abs(charge_delta.z) > 1e-4:
        raise SystemExit("ES7 STAGE-B MOTION BOUNDS FAILED: charge-port hinge displacement is implausible")
    for name in ("mirror_left_mesh", "mirror_right_mesh"):
        if results[name].length > 0.2 or abs(results[name].z) > 1e-4:
            raise SystemExit(f"ES7 STAGE-B MOTION BOUNDS FAILED: {name} fold displacement is implausible")
    print("ES7 STAGE-B MOTION BOUNDS PASS")


if __name__ == "__main__":
    main()
