#!/usr/bin/env python3
"""Render deterministic five-point ES7 Stage-B review frames."""

import json
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import WIPER_REVIEW_KEYFRAMES


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "previews" / "es7-stage-b"
MANIFEST_PATH = OUTPUT_PATH / "review-render-manifest.json"
PROGRESS = (0, 25, 50, 75, 100)
GROUPS = (
    {"id": "charge-port", "frames": (501, 513, 526, 538, 550), "view": "right-front-detail"},
    {"id": "mirror-left", "frames": (551, 563, 576, 588, 600), "view": "left-mirror"},
    {"id": "mirror-right", "frames": (551, 563, 576, 588, 600), "view": "right-mirror"},
    {"id": "wipers", "frames": tuple(WIPER_REVIEW_KEYFRAMES.values()), "view": "windshield"},
    {"id": "suspension", "frames": (671, 688, 706, 723, 740), "view": "side-low"},
)
VIEW_SPECS = {
    "right-front-detail": ((3.7, -3.65, 1.75), (1.05, -0.94, 1.05), 76),
    "left-mirror": ((2.9, 3.8, 1.85), (0.82, 0.94, 1.21), 82),
    "right-mirror": ((2.9, -3.8, 1.85), (0.82, -0.94, 1.21), 82),
    "windshield": ((4.65, 0.0, 3.35), (0.65, 0.0, 1.22), 72),
    "side-low": ((0.0, 7.2, 1.25), (0.0, 0.0, 0.62), 68),
}


def fail(message):
    raise SystemExit(f"ES7 STAGE-B REVIEW RENDER FAILED: {message}")


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def configure_scene(scene):
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 720
    scene.render.resolution_y = 405
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -1.15
    scene.render.image_settings.color_mode = "RGBA"
    for name in ("es7_preview_key", "es7_preview_fill", "es7_preview_rim"):
        light = bpy.data.objects.get(name)
        if light and light.type == "LIGHT":
            light.data.energy *= 0.42


def review_camera():
    camera_data = bpy.data.cameras.new("ES7_STAGE_B_REVIEW_CAMERA_DATA")
    camera = bpy.data.objects.new("ES7_STAGE_B_REVIEW_CAMERA", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    return camera


def apply_view(camera, name):
    location, target, lens = VIEW_SPECS[name]
    camera.location = location
    camera.data.lens = lens
    point_at(camera, target)


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before rendering Stage-B reviews")
    marker = bpy.data.objects.get("ES7_STAGE_B2_SHOWCASE")
    if not marker or marker.get("status") != "stage-b-showcase-built":
        fail("stage_b_showcase has not been built")
    OUTPUT_PATH.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    configure_scene(scene)
    camera = review_camera()
    scene.camera = camera

    requested = {item.strip() for item in os.environ.get("ES7_STAGE_B_REVIEW_GROUPS", "").split(",") if item.strip()}
    known_groups = {group["id"] for group in GROUPS}
    if requested - known_groups:
        fail(f"unknown review groups: {sorted(requested - known_groups)}")
    selected_groups = [group for group in GROUPS if not requested or group["id"] in requested]
    rendered = []
    for group in selected_groups:
        apply_view(camera, group["view"])
        for progress, frame in zip(PROGRESS, group["frames"]):
            scene.frame_set(frame)
            filename = f"{group['id']}--{progress:03d}.png"
            scene.render.filepath = str(OUTPUT_PATH / filename)
            bpy.ops.render.render(write_still=True)
            rendered.append({
                "group": group["id"], "progressPercent": progress, "frame": frame,
                "view": group["view"], "file": filename,
            })
            print(f"- {filename}: frame={frame} view={group['view']}")

    previous = []
    if requested and MANIFEST_PATH.exists():
        report = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        previous = [row for row in report.get("renders", []) if row["group"] not in requested]
    group_order = {group["id"]: index for index, group in enumerate(GROUPS)}
    combined = previous + rendered
    combined.sort(key=lambda row: (group_order[row["group"]], row["progressPercent"]))
    report = {
        "contract": "nio-es7-stage-b-review-renders@0.1.0",
        "source": "source/nio-es7-animation-master.blend",
        "sequence": "stage_b_showcase",
        "resolution": [720, 405],
        "exposure": -1.15,
        "renders": combined,
    }
    MANIFEST_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ES7 STAGE-B REVIEW RENDER PASS: {len(rendered)} images")
    print(f"- selected groups: {', '.join(group['id'] for group in selected_groups)}")
    print(f"- manifest: {MANIFEST_PATH}")


if __name__ == "__main__":
    main()
