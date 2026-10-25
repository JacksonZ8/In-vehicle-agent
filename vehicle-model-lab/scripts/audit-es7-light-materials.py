#!/usr/bin/env python3
"""Audit ES7 lamp-material geometry before semantic extraction."""

import json
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "light-material-audit.json"
OBJECT_NAMES = (
    "es7_work__ES7_Body_L",
    "es7_work__ES7_Body_R",
    "es7_work__ES7_Door_LF",
    "es7_work__ES7_Door_RF",
    "es7_work__Trunk",
)
MATERIAL_NAMES = {
    "2_车灯_前白色",
    "2_车灯_侧白色",
    "2_车灯_前大灯",
    "2_车灯_前大灯2",
    "2_车灯_侧转向",
    "2_车灯_后转向",
    "2_车灯_刹车灯",
    "2_车灯_后红色",
    "3_玻璃_车大灯",
    "3_玻璃_车灯",
}


def fail(message):
    raise SystemExit(f"ES7 LIGHT MATERIAL AUDIT FAILED: {message}")


def rounded(vector):
    return [round(float(value), 6) for value in vector]


def audit_object(obj):
    mesh = obj.data
    polygons_by_material = defaultdict(list)
    for polygon in mesh.polygons:
        if polygon.material_index >= len(mesh.materials):
            continue
        material = mesh.materials[polygon.material_index]
        if material and material.name in MATERIAL_NAMES:
            polygons_by_material[material.name].append(polygon)

    results = []
    for material_name, polygons in sorted(polygons_by_material.items()):
        vertex_indices = sorted({index for polygon in polygons for index in polygon.vertices})
        points = [obj.matrix_world @ mesh.vertices[index].co for index in vertex_indices]
        minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
        maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
        center = sum((obj.matrix_world @ polygon.center for polygon in polygons), Vector()) / len(polygons)
        results.append({
            "material": material_name,
            "polygons": len(polygons),
            "vertices": len(vertex_indices),
            "worldBounds": {
                "minimum": rounded(minimum),
                "maximum": rounded(maximum),
                "center": rounded((minimum + maximum) * 0.5),
                "size": rounded(maximum - minimum),
            },
            "polygonCenterAverage": rounded(center),
        })
    return {"object": obj.name, "materials": results}


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before auditing lights")
    results = []
    for name in OBJECT_NAMES:
        obj = bpy.data.objects.get(name)
        if obj is None or obj.type != "MESH":
            fail(f"missing light source mesh {name}")
        results.append(audit_object(obj))
    report = {
        "contract": "nio-es7-light-material-audit@0.1.0",
        "source": "source/nio-es7-animation-master.blend",
        "objects": results,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("ES7 LIGHT MATERIAL AUDIT PASS")
    for result in results:
        summary = ", ".join(f"{item['material']}={item['polygons']}" for item in result["materials"])
        print(f"- {result['object']}: {summary}")
    print(f"- report: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
