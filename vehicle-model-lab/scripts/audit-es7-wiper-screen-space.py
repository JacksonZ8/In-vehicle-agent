#!/usr/bin/env python3
"""Project ES7 wiper mesh islands into the review-camera image plane."""

import json
from collections import defaultdict
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "wiper-screen-space-audit.json"
SOURCE_NAMES = ("es7_work__ES7_Body_C", "wiper_left_mesh", "wiper_right_mesh")
WIPER_MATERIAL = "1_车身_黑色胶条"
IMAGE_SIZE = (720, 405)


def fail(message):
    raise SystemExit(f"ES7 WIPER SCREEN-SPACE AUDIT FAILED: {message}")


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def island_rows(scene, camera, obj):
    mesh = obj.data
    graph = [[] for _ in mesh.vertices]
    for edge in mesh.edges:
        first, second = edge.vertices
        graph[first].append(second)
        graph[second].append(first)

    polygons_by_vertex = defaultdict(list)
    for polygon in mesh.polygons:
        for vertex_index in polygon.vertices:
            polygons_by_vertex[vertex_index].append(polygon)

    remaining = set(range(len(mesh.vertices)))
    rows = []
    while remaining:
        root = next(iter(remaining))
        vertices = {root}
        stack = [root]
        while stack:
            current = stack.pop()
            for neighbor in graph[current]:
                if neighbor not in vertices:
                    vertices.add(neighbor)
                    stack.append(neighbor)
        remaining.difference_update(vertices)
        polygons = {polygon.index: polygon for index in vertices for polygon in polygons_by_vertex[index]}
        if not polygons:
            continue
        materials = {
            mesh.materials[polygon.material_index].name
            for polygon in polygons.values()
            if polygon.material_index < len(mesh.materials) and mesh.materials[polygon.material_index]
        }
        if WIPER_MATERIAL not in materials:
            continue

        points = [obj.matrix_world @ mesh.vertices[index].co for index in vertices]
        minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
        maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
        center = (minimum + maximum) * 0.5
        size = maximum - minimum
        if not (0.95 < center.x < 1.35 and -0.80 < center.y < 0.80 and 1.18 < center.z < 1.31):
            continue

        normalized = world_to_camera_view(scene, camera, center)
        rows.append({
            "rootVertex": root,
            "vertices": len(vertices),
            "polygons": len(polygons),
            "worldCenter": [round(float(value), 6) for value in center],
            "worldSize": [round(float(value), 6) for value in size],
            "pixelCenter": [
                round(float(normalized.x * IMAGE_SIZE[0]), 2),
                round(float((1.0 - normalized.y) * IMAGE_SIZE[1]), 2),
            ],
        })

    rows.sort(key=lambda row: (row["pixelCenter"][1], row["pixelCenter"][0], -row["polygons"]))
    return rows


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before auditing")

    scene = bpy.context.scene
    scene.frame_set(601)
    camera_data = bpy.data.cameras.new("ES7_WIPER_SCREEN_AUDIT_CAMERA_DATA")
    camera = bpy.data.objects.new("ES7_WIPER_SCREEN_AUDIT_CAMERA", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (4.65, 0.0, 3.35)
    camera.data.lens = 72
    point_at(camera, (0.65, 0.0, 1.22))
    scene.camera = camera
    scene.render.resolution_x, scene.render.resolution_y = IMAGE_SIZE
    scene.render.resolution_percentage = 100
    bpy.context.view_layer.update()

    report = {
        "contract": "nio-es7-wiper-screen-space-audit@0.1.0",
        "frame": 601,
        "imageSize": list(IMAGE_SIZE),
        "objects": {},
    }
    for name in SOURCE_NAMES:
        obj = bpy.data.objects.get(name)
        if obj is None or obj.type != "MESH":
            fail(f"missing mesh {name}")
        report["objects"][name] = island_rows(scene, camera, obj)
        print(f"- {name}: {len(report['objects'][name])} projected islands")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ES7 WIPER SCREEN-SPACE AUDIT PASS: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
