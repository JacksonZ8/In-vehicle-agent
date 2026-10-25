#!/usr/bin/env python3
"""Render the best dry-run ES7 wiper contact-plane candidate without saving."""

import json
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import WIPER_REVIEW_KEYFRAMES


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CALIBRATION_PATH = LAB_ROOT / "references" / "es7-cc-by" / "wiper-contact-plane-calibration.json"
DRY_RUN_CALIBRATION_PATH = LAB_ROOT / "references" / "es7-cc-by" / "working" / "wiper-contact-plane-calibration.dry-run.json"
OUTPUT_PATH = LAB_ROOT / "previews" / "es7-wiper-contact-plane-candidate"
PIVOTS = {"left": "wiper_left_pivot", "right": "wiper_right_pivot"}
FRAMES = tuple((int(progress), frame) for progress, frame in WIPER_REVIEW_KEYFRAMES.items())


def fail(message):
    raise SystemExit(f"ES7 WIPER CONTACT-PLANE CANDIDATE RENDER FAILED: {message}")


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def apply_world_basis(pivot, rows):
    children = {child: child.matrix_world.copy() for child in pivot.children}
    desired_world = Matrix(rows).to_4x4()
    desired_world.translation = pivot.matrix_world.translation.copy()
    pivot.matrix_parent_inverse = (
        pivot.parent.matrix_world.inverted()
        @ desired_world
        @ pivot.matrix_basis.inverted()
    )
    bpy.context.view_layer.update()
    for child, matrix_world in children.items():
        child.matrix_world = matrix_world
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
    calibration_path = DRY_RUN_CALIBRATION_PATH if DRY_RUN_CALIBRATION_PATH.exists() else CALIBRATION_PATH
    if not calibration_path.exists():
        fail(f"missing calibration report {calibration_path}")
    calibration = json.loads(calibration_path.read_text(encoding="utf-8"))
    scene = bpy.context.scene
    scene.frame_set(601)
    bpy.context.view_layer.update()
    for side, pivot_name in PIVOTS.items():
        pivot = bpy.data.objects.get(pivot_name)
        if pivot is None or pivot.parent is None:
            fail(f"missing {side} pivot or parent")
        apply_world_basis(pivot, calibration["wipers"][side]["candidate"]["worldRotation"])

    OUTPUT_PATH.mkdir(parents=True, exist_ok=True)
    configure_scene(scene)
    camera_data = bpy.data.cameras.new("ES7_WIPER_CONTACT_CANDIDATE_CAMERA_DATA")
    camera = bpy.data.objects.new("ES7_WIPER_CONTACT_CANDIDATE_CAMERA", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (4.65, 0.0, 3.35)
    camera.data.lens = 72
    point_at(camera, (0.65, 0.0, 1.22))
    scene.camera = camera

    for progress, frame in FRAMES:
        scene.frame_set(frame)
        scene.render.filepath = str(OUTPUT_PATH / f"wipers--{progress:03d}.png")
        bpy.ops.render.render(write_still=True)
        print(f"- wipers--{progress:03d}.png")
    print(f"ES7 WIPER CONTACT-PLANE CANDIDATE RENDER PASS: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
