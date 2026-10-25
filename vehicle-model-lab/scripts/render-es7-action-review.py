#!/usr/bin/env python3
"""Render deterministic five-point ES7 Stage-A action review frames."""

import json
import os
from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "previews" / "es7-actions"
MANIFEST_PATH = OUTPUT_PATH / "review-render-manifest.json"
PROGRESS = (0, 25, 50, 75, 100)


GROUPS = (
    {"id": "lights-front", "frames": (1, 23, 46, 68, 90), "view": "front45"},
    {"id": "lights-rear", "frames": (1, 23, 46, 68, 90), "view": "rear45"},
    {"id": "handles", "frames": (91, 101, 111, 120, 130), "view": "left-detail"},
    {"id": "windows", "frames": (131, 143, 156, 168, 180), "view": "side"},
    {"id": "doors", "frames": (181, 198, 216, 233, 250), "view": "front45"},
    {"id": "hood", "frames": (251, 266, 281, 295, 310), "view": "front45"},
    {"id": "tailgate", "frames": (311, 328, 346, 363, 380), "view": "rear45"},
    {"id": "steering", "frames": (381, 396, 411, 425, 440), "view": "front-low"},
    {"id": "wheel-roll", "frames": (441, 456, 471, 485, 500), "view": "wheel-detail"},
)


VIEW_SPECS = {
    "front45": ((6.6, 5.15, 2.7), (0.25, 0.0, 0.8), 62),
    "side": ((0.0, 8.0, 1.9), (0.0, 0.0, 0.85), 65),
    "rear45": ((-6.4, 5.0, 2.65), (-0.35, 0.0, 0.85), 62),
    "left-detail": ((0.9, 4.3, 1.45), (0.25, 0.75, 1.0), 72),
    "front-low": ((5.1, 4.2, 1.25), (1.15, 0.0, 0.48), 70),
    "wheel-detail": ((1.59, 3.8, 0.92), (1.59, 0.84, 0.46), 70),
}


def fail(message):
    raise SystemExit(f"ES7 ACTION REVIEW RENDER FAILED: {message}")


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
    camera_data = bpy.data.cameras.new("ES7_ACTION_REVIEW_CAMERA_DATA")
    camera = bpy.data.objects.new("ES7_ACTION_REVIEW_CAMERA", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    return camera


def apply_view(camera, name):
    location, target, lens = VIEW_SPECS[name]
    camera.location = location
    camera.data.lens = lens
    point_at(camera, target)


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before rendering action reviews")
    marker = bpy.data.objects.get("ES7_STAGE_A3_SHOWCASE")
    if not marker or marker.get("status") != "stage-a-showcase-built":
        fail("stage_a_showcase has not been built")
    OUTPUT_PATH.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    configure_scene(scene)
    camera = review_camera()
    scene.camera = camera

    requested = {item.strip() for item in os.environ.get("ES7_REVIEW_GROUPS", "").split(",") if item.strip()}
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
                "group": group["id"],
                "progressPercent": progress,
                "frame": frame,
                "view": group["view"],
                "file": filename,
            })
            print(f"- {filename}: frame={frame} view={group['view']}")

    previous = []
    if requested and MANIFEST_PATH.exists():
        previous_report = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        previous = [row for row in previous_report.get("renders", []) if row["group"] not in requested]
    group_order = {group["id"]: index for index, group in enumerate(GROUPS)}
    combined = previous + rendered
    combined.sort(key=lambda row: (group_order[row["group"]], row["progressPercent"]))
    report = {
        "contract": "nio-es7-stage-a-review-renders@0.1.0",
        "source": "source/nio-es7-animation-master.blend",
        "sequence": "stage_a_showcase",
        "resolution": [720, 405],
        "exposure": -1.15,
        "renders": combined,
    }
    MANIFEST_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ES7 ACTION REVIEW RENDER PASS: {len(rendered)} images")
    print(f"- selected groups: {', '.join(group['id'] for group in selected_groups)}")
    print(f"- manifest: {MANIFEST_PATH}")


if __name__ == "__main__":
    main()
