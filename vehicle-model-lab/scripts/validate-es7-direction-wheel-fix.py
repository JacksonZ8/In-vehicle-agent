#!/usr/bin/env python3
"""Validate corrected hood/mirror directions and unused wheel exclusion in Blender."""

import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import objects_world_bounds as world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
UNUSED_WHEEL_ROOTS = (
    "es7_work__20_INCH_ELEGANT_DARE ",
    "es7_work__21_INCH_DESIGN_1 ",
    "es7_work__21_INCH_DESIGN_3",
    "es7_work__22_INCH_DESIGN_1",
)


def fail(message):
    raise SystemExit(f"ES7 DIRECTION/WHEEL FIX VALIDATION FAILED: {message}")


def world_center(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return (minimum + maximum) * 0.5


def descendants(root):
    result = []
    stack = list(root.children)
    while stack:
        obj = stack.pop()
        result.append(obj)
        stack.extend(obj.children)
    return result


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validation")
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    actions = {action["id"]: action for action in schema["mechanicalActions"]}
    if actions["hood_open"]["range"] != [-0.78, 0.0]:
        fail("hood schema direction is not negative Y")
    if actions["mirror_left_fold"]["range"] != [0.0, 1.05]:
        fail("left mirror schema direction is not positive Z")
    if actions["mirror_right_fold"]["range"] != [-1.05, 0.0]:
        fail("right mirror schema direction is not negative Z")

    marker = bpy.data.objects.get("ES7_DIRECTION_WHEEL_GHOST_FIX")
    if not marker or marker.get("status") != "directions-corrected-unused-wheel-variants-hidden":
        fail("direction/wheel fix marker is missing")
    hidden_meshes = 0
    for root_name in UNUSED_WHEEL_ROOTS:
        root = bpy.data.objects.get(root_name)
        if not root:
            fail(f"unused wheel root is missing: {root_name}")
        for obj in [root, *descendants(root)]:
            if not obj.get("export_forbidden") or not obj.hide_render or not obj.hide_viewport:
                fail(f"unused wheel object is still visible/exportable: {obj.name}")
            hidden_meshes += int(obj.type == "MESH")
    if hidden_meshes < 6:
        fail(f"only {hidden_meshes} unused wheel meshes were excluded")
    for name in (
        "wheel_mesh_front_left", "wheel_mesh_front_right",
        "wheel_mesh_rear_left", "wheel_mesh_rear_right",
    ):
        obj = bpy.data.objects.get(name)
        if not obj or obj.get("export_forbidden") or obj.hide_render:
            fail(f"controlled Wheel1 mesh is unavailable: {name}")
    static_wheel = bpy.data.objects.get("es7_work__Mesh")
    if not static_wheel or not static_wheel.get("export_forbidden") or not static_wheel.hide_render:
        fail("the remaining static front-wheel ghost is still visible/exportable")

    scene = bpy.context.scene
    samples = {
        "hood_mesh_left": (251, 281),
        "mirror_left_mesh": (551, 576),
        "mirror_right_mesh": (551, 576),
    }
    motion = {}
    for name, (closed_frame, open_frame) in samples.items():
        obj = bpy.data.objects[name]
        scene.frame_set(closed_frame)
        bpy.context.view_layer.update()
        closed = world_center(obj)
        scene.frame_set(open_frame)
        bpy.context.view_layer.update()
        opened = world_center(obj)
        motion[name] = opened - closed
    scene.frame_set(251)
    bpy.context.view_layer.update()
    hood_bounds = world_bounds((bpy.data.objects["hood_mesh_left"], bpy.data.objects["hood_mesh_right"]))
    if not (0.95 < hood_bounds[0].z < 1.05 and 1.20 < hood_bounds[1].z < 1.35):
        fail(f"hood closed pose is detached from the body: bounds={tuple((*hood_bounds[0], *hood_bounds[1]))}")
    pivot = bpy.data.objects["hood_pivot"]
    expected_hinge = Vector((hood_bounds[0].x + 0.015, 0.0, hood_bounds[1].z - 0.02))
    if (pivot.matrix_world.translation - expected_hinge).length > 1e-4:
        fail(f"hood hinge does not match the restored closed pose: {tuple(pivot.matrix_world.translation)}")
    if not 0.3 < motion["hood_mesh_left"].z < 1.2:
        fail(f"hood does not rise: delta={tuple(motion['hood_mesh_left'])}")
    for name in ("mirror_left_mesh", "mirror_right_mesh"):
        if motion[name].x >= -0.02:
            fail(f"{name} does not fold rearward: delta={tuple(motion[name])}")

    print("ES7 DIRECTION/WHEEL FIX VALIDATION PASS")
    print(f"- unused wheel meshes hidden/export-forbidden: {hidden_meshes}")
    print(f"- hood vertical delta: {motion['hood_mesh_left'].z:.4f} m")
    print(f"- hood closed Z bounds: {hood_bounds[0].z:.4f}-{hood_bounds[1].z:.4f} m")
    print(f"- mirror rearward X deltas: {motion['mirror_left_mesh'].x:.4f}/{motion['mirror_right_mesh'].x:.4f} m")


if __name__ == "__main__":
    main()
