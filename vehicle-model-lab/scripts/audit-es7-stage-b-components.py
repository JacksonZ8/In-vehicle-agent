#!/usr/bin/env python3
"""Audit connected islands that may supply ES7 Stage-B moving components."""

import json
from collections import Counter, defaultdict
from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "stage-b-component-audit.json"
TARGET_OBJECTS = (
    "es7_work__ES7_Body_C",
    "es7_work__ES7_Body_L",
    "es7_work__ES7_Body_R",
    "es7_work__ES7_Door_LF",
    "es7_work__ES7_Door_RF",
)


def fail(message):
    raise SystemExit(f"ES7 STAGE-B COMPONENT AUDIT FAILED: {message}")


class DisjointSet:
    def __init__(self, size):
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, value):
        if self.parent[value] != value:
            self.parent[value] = self.find(self.parent[value])
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


def material_name(mesh, polygon_index):
    material_index = mesh.polygons[polygon_index].material_index
    if material_index >= len(mesh.materials) or mesh.materials[material_index] is None:
        return "<none>"
    return mesh.materials[material_index].name


def semantic_tags(materials, center, size):
    joined = " ".join(materials)
    tags = []
    if "后视镜" in joined:
        tags.append("mirror-material")
    if "雨刷" in joined or "雨刮" in joined:
        tags.append("wiper-material")
    if center.x > 1.0 and center.y < -0.55 and 0.45 < center.z < 1.45 and max(size) < 0.8:
        tags.append("front-right-charge-port-region")
    if center.x > 0.0 and abs(center.y) < 0.85 and center.z > 0.85 and max(size) < 1.7:
        tags.append("windshield-base-region")
    return tags


def audit_object(obj):
    mesh = obj.data
    sets = DisjointSet(len(mesh.vertices))
    for edge in mesh.edges:
        sets.union(edge.vertices[0], edge.vertices[1])

    vertices_by_root = defaultdict(list)
    polygons_by_root = defaultdict(list)
    for vertex in mesh.vertices:
        vertices_by_root[sets.find(vertex.index)].append(vertex.index)
    for polygon in mesh.polygons:
        polygons_by_root[sets.find(polygon.vertices[0])].append(polygon.index)

    islands = []
    for root, vertex_indices in vertices_by_root.items():
        polygon_indices = polygons_by_root.get(root, [])
        if not polygon_indices:
            continue
        points = [obj.matrix_world @ mesh.vertices[index].co for index in vertex_indices]
        minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
        maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
        center = (minimum + maximum) * 0.5
        size = maximum - minimum
        materials = Counter(material_name(mesh, index) for index in polygon_indices)
        islands.append({
            "rootVertex": root,
            "vertices": len(vertex_indices),
            "polygons": len(polygon_indices),
            "worldBounds": {
                "minimum": rounded(minimum),
                "maximum": rounded(maximum),
                "center": rounded(center),
                "size": rounded(size),
            },
            "materials": [
                {"name": name, "polygons": count}
                for name, count in materials.most_common()
            ],
            "semanticTags": semantic_tags(materials, center, size),
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
        fail(f"open {MASTER_PATH} before auditing Stage-B components")
    results = []
    for name in TARGET_OBJECTS:
        obj = bpy.data.objects.get(name)
        if obj is None or obj.type != "MESH":
            fail(f"missing target mesh {name}")
        results.append(audit_object(obj))

    candidates = []
    for result in results:
        for island in result["islands"]:
            if island["semanticTags"]:
                candidates.append({
                    "islandId": island["islandId"],
                    "object": result["object"],
                    "polygons": island["polygons"],
                    "worldBounds": island["worldBounds"],
                    "materials": island["materials"],
                    "semanticTags": island["semanticTags"],
                })

    report = {
        "contract": "nio-es7-stage-b-component-audit@0.1.0",
        "source": "source/nio-es7-animation-master.blend",
        "coordinateSystem": {"forward": "+X", "left": "+Y", "up": "+Z"},
        "objects": results,
        "candidates": candidates,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("ES7 STAGE-B COMPONENT AUDIT PASS")
    for result in results:
        print(f"- {result['object']}: {result['polygons']} polygons, {result['islandCount']} islands")
    print(f"- tagged candidates: {len(candidates)}")
    print(f"- report: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
