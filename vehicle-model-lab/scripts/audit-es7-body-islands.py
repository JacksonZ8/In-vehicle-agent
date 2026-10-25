#!/usr/bin/env python3
"""Audit connected geometry islands in the ES7 exterior body halves."""

import json
from collections import Counter, defaultdict
from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "body-island-audit.json"
OBJECT_NAMES = ("es7_work__ES7_Body_L", "es7_work__ES7_Body_R")


def fail(message):
    raise SystemExit(f"ES7 BODY ISLAND AUDIT FAILED: {message}")


class DisjointSet:
    def __init__(self, size):
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, value):
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, first, second):
        first_root = self.find(first)
        second_root = self.find(second)
        if first_root == second_root:
            return
        if self.rank[first_root] < self.rank[second_root]:
            first_root, second_root = second_root, first_root
        self.parent[second_root] = first_root
        if self.rank[first_root] == self.rank[second_root]:
            self.rank[first_root] += 1


def rounded(vector):
    return [round(float(value), 6) for value in vector]


def audit_object(obj):
    mesh = obj.data
    sets = DisjointSet(len(mesh.vertices))
    for edge in mesh.edges:
        sets.union(edge.vertices[0], edge.vertices[1])

    vertices_by_root = defaultdict(list)
    for vertex in mesh.vertices:
        vertices_by_root[sets.find(vertex.index)].append(vertex.index)

    polygons_by_root = defaultdict(list)
    for polygon in mesh.polygons:
        root = sets.find(polygon.vertices[0])
        polygons_by_root[root].append(polygon.index)

    islands = []
    for root, vertex_indices in vertices_by_root.items():
        polygon_indices = polygons_by_root.get(root, [])
        if not polygon_indices:
            continue
        points = [obj.matrix_world @ mesh.vertices[index].co for index in vertex_indices]
        minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
        maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
        material_counts = Counter(
            mesh.materials[mesh.polygons[index].material_index].name
            if mesh.polygons[index].material_index < len(mesh.materials)
            and mesh.materials[mesh.polygons[index].material_index]
            else "<none>"
            for index in polygon_indices
        )
        islands.append({
            "rootVertex": root,
            "vertices": len(vertex_indices),
            "polygons": len(polygon_indices),
            "worldBounds": {
                "minimum": rounded(minimum),
                "maximum": rounded(maximum),
                "center": rounded((minimum + maximum) * 0.5),
                "size": rounded(maximum - minimum),
            },
            "materials": [
                {"name": name, "polygons": count}
                for name, count in material_counts.most_common()
            ],
        })

    islands.sort(key=lambda island: (-island["polygons"], island["rootVertex"]))
    for index, island in enumerate(islands):
        island["islandId"] = f"{obj.name}:island-{index:03d}"
    return {
        "object": obj.name,
        "vertices": len(mesh.vertices),
        "polygons": len(mesh.polygons),
        "islandCount": len(islands),
        "islands": islands,
    }


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before auditing body islands")
    objects = []
    for name in OBJECT_NAMES:
        obj = bpy.data.objects.get(name)
        if obj is None or obj.type != "MESH":
            fail(f"missing body mesh {name}")
        objects.append(audit_object(obj))

    report = {
        "contract": "nio-es7-body-island-audit@0.1.0",
        "source": "source/nio-es7-animation-master.blend",
        "objects": objects,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("ES7 BODY ISLAND AUDIT PASS")
    for result in objects:
        print(f"- {result['object']}: {result['vertices']} vertices, {result['polygons']} polygons, {result['islandCount']} islands")
    print(f"- report: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
