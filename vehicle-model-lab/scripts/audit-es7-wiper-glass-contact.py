#!/usr/bin/env python3
"""Audit ES7 original wiper-blade clearance from the front windshield."""

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import WIPER_REVIEW_KEYFRAMES


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "wiper-glass-contact-audit.json"
GLASS_NAME = "es7_work__ES7_Glass1"
WIPERS = {"left": "wiper_left_mesh", "right": "wiper_right_mesh"}
FRAMES = WIPER_REVIEW_KEYFRAMES
BLADE_MIN_LENGTH = 0.35
SAMPLE_BINS = 9
OUTWARD_AXIS = Vector((1.0, 0.0, 0.0))


def fail(message):
    raise SystemExit(f"ES7 WIPER/GLASS CONTACT AUDIT FAILED: {message}")


def rounded(values, digits=6):
    return [round(float(value), digits) for value in values]


def connected_islands(obj):
    mesh = obj.data
    graph = [[] for _ in mesh.vertices]
    for edge in mesh.edges:
        first, second = edge.vertices
        graph[first].append(second)
        graph[second].append(first)

    polygons_by_vertex = defaultdict(list)
    for polygon in mesh.polygons:
        for vertex_index in polygon.vertices:
            polygons_by_vertex[vertex_index].append(polygon.index)

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
        polygons = {index for vertex in vertices for index in polygons_by_vertex[vertex]}
        if not polygons:
            continue
        points = [obj.matrix_world @ mesh.vertices[index].co for index in vertices]
        minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
        maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
        size = maximum - minimum
        rows.append({
            "rootVertex": root,
            "vertices": vertices,
            "polygons": len(polygons),
            "center": (minimum + maximum) * 0.5,
            "size": size,
        })
    return rows


def world_bvh(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    vertices = [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
    triangles = [tuple(loop.vertices) for loop in mesh.loop_triangles]
    return BVHTree.FromPolygons(vertices, triangles, all_triangles=True)


def nearest_row(tree, point):
    location, normal, face_index, distance = tree.find_nearest(point)
    if location is None or normal is None:
        fail("windshield BVH did not return a nearest surface")
    normal = normal.normalized()
    if normal.dot(OUTWARD_AXIS) < 0.0:
        normal.negate()
    return {
        "location": location,
        "normal": normal,
        "faceIndex": face_index,
        "distance": float(distance),
        "rawSigned": float((point - location).dot(normal)),
    }


def choose_blade_vertices(obj, tree):
    islands = [row for row in connected_islands(obj) if max(row["size"]) >= BLADE_MIN_LENGTH]
    if not islands:
        fail(f"no long original blade islands found on {obj.name}")
    candidates = sorted(set().union(*(row["vertices"] for row in islands)))
    world_points = {index: obj.matrix_world @ obj.data.vertices[index].co for index in candidates}
    axis = max(range(3), key=lambda item: max(point[item] for point in world_points.values()) - min(point[item] for point in world_points.values()))
    minimum = min(point[axis] for point in world_points.values())
    maximum = max(point[axis] for point in world_points.values())
    span = maximum - minimum
    if span <= 0.0:
        fail(f"blade span is empty on {obj.name}")

    samples = []
    for bin_index in range(SAMPLE_BINS):
        low = minimum + span * bin_index / SAMPLE_BINS
        high = minimum + span * (bin_index + 1) / SAMPLE_BINS
        members = [
            index for index, point in world_points.items()
            if low <= point[axis] <= high or (bin_index == SAMPLE_BINS - 1 and point[axis] <= high)
        ]
        if not members:
            continue
        ranked = sorted(
            members,
            key=lambda index: (
                nearest_row(tree, world_points[index])["rawSigned"] < 0.0,
                abs(nearest_row(tree, world_points[index])["rawSigned"]),
            ),
        )
        for sample_index in ranked[:1]:
            if sample_index not in samples:
                samples.append(sample_index)
    if len(samples) < 5:
        fail(f"only {len(samples)} blade contact samples found on {obj.name}")
    return islands, axis, samples


def gap_stats(values):
    ordered = sorted(values)
    return {
        "minimumMeters": round(ordered[0], 6),
        "medianMeters": round(statistics.median(ordered), 6),
        "maximumMeters": round(ordered[-1], 6),
        "penetratingSamples": sum(value < 0.0 for value in ordered),
    }


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before auditing")
    glass = bpy.data.objects.get(GLASS_NAME)
    if glass is None or glass.type != "MESH":
        fail(f"missing windshield mesh {GLASS_NAME}")
    wipers = {side: bpy.data.objects.get(name) for side, name in WIPERS.items()}
    if any(obj is None or obj.type != "MESH" for obj in wipers.values()):
        fail("left or right original wiper mesh is missing")

    scene = bpy.context.scene
    scene.frame_set(FRAMES["0"])
    bpy.context.view_layer.update()
    tree = world_bvh(glass)
    selection = {}
    for side, obj in wipers.items():
        islands, axis, samples = choose_blade_vertices(obj, tree)
        selection[side] = {"islands": islands, "axis": axis, "samples": samples}

    report = {
        "contract": "nio-es7-wiper-glass-contact-audit@0.1.0",
        "source": "source/nio-es7-animation-master.blend",
        "windshield": {
            "object": GLASS_NAME,
            "vertices": len(glass.data.vertices),
            "triangles": len(glass.data.loop_triangles),
        },
        "frames": FRAMES,
        "wipers": {},
    }
    for side, obj in wipers.items():
        selected = selection[side]
        rows = {}
        for progress, frame in FRAMES.items():
            scene.frame_set(frame)
            bpy.context.view_layer.update()
            gaps = []
            sample_rows = []
            for vertex_index in selected["samples"]:
                point = obj.matrix_world @ obj.data.vertices[vertex_index].co
                nearest = nearest_row(tree, point)
                signed_gap = nearest["rawSigned"]
                gaps.append(signed_gap)
                sample_rows.append({
                    "vertex": vertex_index,
                    "world": rounded(point),
                    "nearestGlass": rounded(nearest["location"]),
                    "signedGapMeters": round(signed_gap, 6),
                })
            rows[progress] = {"frame": frame, "statistics": gap_stats(gaps), "samples": sample_rows}
        report["wipers"][side] = {
            "object": obj.name,
            "bladeIslandRoots": [row["rootVertex"] for row in selected["islands"]],
            "bladeIslandCount": len(selected["islands"]),
            "longitudinalWorldAxis": "XYZ"[selected["axis"]],
            "normalOrientation": "+X outward",
            "sampleVertices": selected["samples"],
            "keyframes": rows,
        }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("ES7 WIPER/GLASS CONTACT AUDIT PASS")
    print(f"- windshield: {GLASS_NAME}, {len(glass.data.loop_triangles)} triangles")
    for side in ("left", "right"):
        item = report["wipers"][side]
        print(f"- {side}: {item['bladeIslandCount']} blade islands, {len(item['sampleVertices'])} samples")
        for progress in ("0", "25", "50", "75", "100"):
            stats = item["keyframes"][progress]["statistics"]
            print(
                f"  - {progress}%: min/median/max="
                f"{stats['minimumMeters']:.4f}/{stats['medianMeters']:.4f}/{stats['maximumMeters']:.4f} m, "
                f"penetrating={stats['penetratingSamples']}"
            )
    print(f"- report: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
