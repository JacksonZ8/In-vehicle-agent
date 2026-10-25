#!/usr/bin/env python3
"""Render the original long wiper around its actual arm-root candidate."""

from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "previews" / "es7-wiper-pivot-candidates"
RIGHT_PIVOT = Vector((1.277216, -0.136966, 1.246273))


def fail(message):
    raise SystemExit(f"ES7 WIPER PIVOT CANDIDATE RENDER FAILED: {message}")


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def relocate_pivot(pivot, origin):
    child_matrices = {child: child.matrix_world.copy() for child in pivot.children}
    matrix_world = pivot.matrix_world.copy()
    matrix_world.translation = origin
    pivot.matrix_world = matrix_world
    bpy.context.view_layer.update()
    for child, child_matrix in child_matrices.items():
        child.matrix_world = child_matrix
    bpy.context.view_layer.update()


def configure_scene(scene):
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 720
    scene.render.resolution_y = 405
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -1.15
    for name in ("es7_preview_key", "es7_preview_fill", "es7_preview_rim"):
        light = bpy.data.objects.get(name)
        if light and light.type == "LIGHT":
            light.data.energy *= 0.42


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before rendering")

    scene = bpy.context.scene
    scene.frame_set(601)
    pivot = bpy.data.objects.get("wiper_right_pivot")
    right = bpy.data.objects.get("wiper_right_mesh")
    left = bpy.data.objects.get("wiper_left_mesh")
    if pivot is None or right is None or left is None:
        fail("right pivot or wiper meshes are missing")

    pivot.animation_data_clear()
    relocate_pivot(pivot, RIGHT_PIVOT)
    left.hide_render = True
    configure_scene(scene)
    OUTPUT_PATH.mkdir(parents=True, exist_ok=True)

    camera_data = bpy.data.cameras.new("ES7_WIPER_PIVOT_CANDIDATE_CAMERA_DATA")
    camera = bpy.data.objects.new("ES7_WIPER_PIVOT_CANDIDATE_CAMERA", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (4.65, 0.0, 3.35)
    camera.data.lens = 72
    point_at(camera, (0.65, 0.0, 1.22))
    scene.camera = camera

    for label, angle in (("rest", 0.0), ("negative", -1.08), ("positive", 1.08)):
        pivot.rotation_euler.z = angle
        bpy.context.view_layer.update()
        scene.render.filepath = str(OUTPUT_PATH / f"right-root-{label}.png")
        bpy.ops.render.render(write_still=True)
        print(f"- right-root-{label}.png")

    print(f"ES7 WIPER PIVOT CANDIDATE RENDER PASS: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
