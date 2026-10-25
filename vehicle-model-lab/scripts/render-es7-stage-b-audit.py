#!/usr/bin/env python3
"""Render deterministic close-ups for ES7 Stage-B component selection."""

from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "previews" / "es7-stage-b-audit"
VIEWS = {
    "charge-port-right-front": ((2.55, -2.9, 1.65), (1.22, -0.94, 1.04), 75),
    "mirror-left": ((1.65, 2.65, 1.65), (0.73, 1.02, 1.27), 80),
    "mirror-right": ((1.65, -2.65, 1.65), (0.73, -1.02, 1.27), 80),
    "windshield-base": ((2.25, 0.0, 2.75), (0.93, 0.0, 1.28), 78),
}


def fail(message):
    raise SystemExit(f"ES7 STAGE-B AUDIT RENDER FAILED: {message}")


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before rendering Stage-B audit views")
    OUTPUT_PATH.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    scene.frame_set(1)
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 720
    scene.render.resolution_y = 540
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.6

    camera_data = bpy.data.cameras.new("ES7_STAGE_B_AUDIT_CAMERA_DATA")
    camera = bpy.data.objects.new("ES7_STAGE_B_AUDIT_CAMERA", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    for view_id, (location, target, lens) in VIEWS.items():
        camera.location = location
        camera.data.lens = lens
        point_at(camera, target)
        scene.render.filepath = str(OUTPUT_PATH / f"{view_id}.png")
        bpy.ops.render.render(write_still=True)
        print(f"- {view_id}.png")
    print(f"ES7 STAGE-B AUDIT RENDER PASS: {len(VIEWS)} images")
    print(f"- output: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
