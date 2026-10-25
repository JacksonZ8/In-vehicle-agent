#!/usr/bin/env python3
"""Audit current ES7 wiper and windshield-base island ownership."""

import json
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "wiper-hierarchy-audit.json"
SOURCE_NAMES = ("es7_work__ES7_Body_C", "wiper_left_mesh", "wiper_right_mesh")
WIPER_MATERIALS = {"1_车身_黑色胶条", "1_车身_钢琴漆"}


def fail(message):
    raise SystemExit(f"ES7 WIPER HIERARCHY AUDIT FAILED: {message}")


def rounded(vector):
    return [round(float(value), 6) for value in vector]


def island_rows(obj):
    mesh = obj.data
    graph = [[] for _ in mesh.vertices]
    for edge in mesh.edges:
        first, second = edge.vertices
        graph[first].append(second)
        graph[second].append(first)

    remaining = set(range(len(mesh.vertices)))
    polygons_by_vertex = defaultdict(list)
    for polygon in mesh.polygons:
        for vertex_index in polygon.vertices:
            polygons_by_vertex[vertex_index].append(polygon)

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
        points = [obj.matrix_world @ mesh.vertices[index].co for index in vertices]
        minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
        maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
        center = (minimum + maximum) * 0.5
        size = maximum - minimum
        material_names = sorted({
            mesh.materials[polygon.material_index].name
            for polygon in polygons.values()
            if polygon.material_index < len(mesh.materials) and mesh.materials[polygon.material_index]
        })
        if not (
            0.95 < center.x < 1.35
            and -0.80 < center.y < 0.80
            and 1.18 < center.z < 1.31
            and set(material_names).intersection(WIPER_MATERIALS)
        ):
            continue
        rows.append({
            "rootVertex": root,
            "vertices": len(vertices),
            "polygons": len(polygons),
            "center": rounded(center),
            "size": rounded(size),
            "materials": material_names,
        })

    rows.sort(key=lambda row: (-row["polygons"], row["center"][1], row["rootVertex"]))
    return rows


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before auditing")
    report = {
        "contract": "nio-es7-wiper-hierarchy-audit@0.1.0",
        "source": "source/nio-es7-animation-master.blend",
        "objects": {},
    }
    for name in SOURCE_NAMES:
        obj = bpy.data.objects.get(name)
        if obj is None or obj.type != "MESH":
            fail(f"missing mesh {name}")
        report["objects"][name] = island_rows(obj)
        print(f"- {name}: {len(report['objects'][name])} nearby islands")
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ES7 WIPER HIERARCHY AUDIT PASS: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
