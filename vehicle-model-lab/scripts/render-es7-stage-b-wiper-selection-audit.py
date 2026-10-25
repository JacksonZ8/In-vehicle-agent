#!/usr/bin/env python3
"""Render alternative wiper-island filters without saving the Blender master."""

from pathlib import Path

import bmesh
import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "previews" / "es7-stage-b-wiper-selection-audit"
SOURCE_NAMES = ("wiper_left_mesh", "wiper_right_mesh")
VARIANTS = {
    "long-only": lambda center, size: size.y > 0.40,
    "major": lambda center, size: size.y > 0.18 and center.x < 1.29,
    "major-plus": lambda center, size: size.y > 0.10 and center.x < 1.29,
}


def fail(message):
    raise SystemExit(f"ES7 WIPER SELECTION AUDIT FAILED: {message}")


def islands(obj):
    mesh = obj.data
    graph = [[] for _ in mesh.vertices]
    for edge in mesh.edges:
        first, second = edge.vertices
        graph[first].append(second)
        graph[second].append(first)
    remaining = set(range(len(mesh.vertices)))
    result = []
    while remaining:
        root = next(iter(remaining))
        found = {root}
        stack = [root]
        while stack:
            current = stack.pop()
            for neighbor in graph[current]:
                if neighbor not in found:
                    found.add(neighbor)
                    stack.append(neighbor)
        remaining.difference_update(found)
        points = [obj.matrix_world @ mesh.vertices[index].co for index in found]
        minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
        maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
        result.append((found, (minimum + maximum) * 0.5, maximum - minimum))
    return result


def keep_vertices(obj, indices):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[vertex for vertex in bm.verts if vertex.index not in indices], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


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
    OUTPUT_PATH.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    scene.frame_set(601)
    bpy.context.view_layer.update()
    source_islands = {name: islands(bpy.data.objects[name]) for name in SOURCE_NAMES}
    for name in SOURCE_NAMES:
        bpy.data.objects[name].hide_render = True

    configure_scene(scene)
    camera_data = bpy.data.cameras.new("ES7_WIPER_SELECTION_AUDIT_CAMERA_DATA")
    camera = bpy.data.objects.new("ES7_WIPER_SELECTION_AUDIT_CAMERA", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (4.65, 0.0, 3.35)
    camera.data.lens = 72
    point_at(camera, (0.65, 0.0, 1.22))
    scene.camera = camera

    for variant, predicate in VARIANTS.items():
        copies = []
        for source_name in SOURCE_NAMES:
            source = bpy.data.objects[source_name]
            duplicate = source.copy()
            duplicate.data = source.data.copy()
            duplicate.name = f"audit__{variant}__{source_name}"
            source.users_collection[0].objects.link(duplicate)
            selected = set()
            for vertices, center, size in source_islands[source_name]:
                if predicate(center, size):
                    selected.update(vertices)
            keep_vertices(duplicate, selected)
            duplicate.hide_render = False
            copies.append(duplicate)
        for progress, frame in ((0, 601), (50, 636)):
            scene.frame_set(frame)
            scene.render.filepath = str(OUTPUT_PATH / f"{variant}--{progress:03d}.png")
            bpy.ops.render.render(write_still=True)
        for duplicate in copies:
            bpy.data.objects.remove(duplicate, do_unlink=True)
        print(f"- {variant}: rendered")
    print(f"ES7 WIPER SELECTION AUDIT PASS: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
