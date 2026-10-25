#!/usr/bin/env python3
"""Render current ES7 wiper objects separately without saving the Blender master."""

from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "previews" / "es7-wiper-object-isolation"
WIPERS = {
    "left": ("wiper_left_mesh",),
    "right": ("wiper_right_mesh", "wiper_right_original_tip_parts"),
}


def fail(message):
    raise SystemExit(f"ES7 WIPER OBJECT ISOLATION FAILED: {message}")


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


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
    objects = {side: [bpy.data.objects.get(name) for name in names] for side, names in WIPERS.items()}
    if any(obj is None for group in objects.values() for obj in group):
        fail("left or right wiper mesh is missing")

    OUTPUT_PATH.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    configure_scene(scene)
    camera_data = bpy.data.cameras.new("ES7_WIPER_ISOLATION_CAMERA_DATA")
    camera = bpy.data.objects.new("ES7_WIPER_ISOLATION_CAMERA", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (4.65, 0.0, 3.35)
    camera.data.lens = 72
    point_at(camera, (0.65, 0.0, 1.22))
    scene.camera = camera

    original_visibility = {obj: obj.hide_render for group in objects.values() for obj in group}
    for visible_side in ("left", "right"):
        for side, group in objects.items():
            for obj in group:
                obj.hide_render = side != visible_side
        for progress, frame in ((0, 601), (50, 636)):
            scene.frame_set(frame)
            scene.render.filepath = str(OUTPUT_PATH / f"{visible_side}-only--{progress:03d}.png")
            bpy.ops.render.render(write_still=True)
            print(f"- {visible_side}-only--{progress:03d}.png")

    for obj, hidden in original_visibility.items():
        obj.hide_render = hidden
    print(f"ES7 WIPER OBJECT ISOLATION PASS: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
