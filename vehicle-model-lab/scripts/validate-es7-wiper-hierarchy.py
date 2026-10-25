#!/usr/bin/env python3
"""Validate ES7 semantic wiper ownership, spindle origins, and round trip."""

from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
BODY_NAME = "es7_work__ES7_Body_C"
WIPERS = {
    "left": (("wiper_left_mesh",), "wiper_left_pivot", Vector((1.2165, 0.6922, 1.1930))),
    "right": (("wiper_right_mesh", "wiper_right_original_tip_parts"), "wiper_right_pivot", Vector((1.277216, -0.136966, 1.246273))),
}
WIPER_MATERIAL = "1_车身_黑色胶条"
STATIC_TRIM_MATERIAL = "1_车身_钢琴漆"


def fail(message):
    raise SystemExit(f"ES7 WIPER HIERARCHY VALIDATION FAILED: {message}")


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
        points = [obj.matrix_world @ mesh.vertices[index].co for index in vertices]
        minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
        maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
        materials = {
            mesh.materials[polygon.material_index].name
            for polygon in polygons.values()
            if polygon.material_index < len(mesh.materials) and mesh.materials[polygon.material_index]
        }
        rows.append({
            "center": (minimum + maximum) * 0.5,
            "size": maximum - minimum,
            "materials": materials,
        })
    return rows


def assembly_bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return minimum, maximum


def nearby_static_rows(body):
    return [
        island for island in connected_islands(body)
        if (
            0.95 < island["center"].x < 1.35
            and -0.80 < island["center"].y < 0.80
            and 1.18 < island["center"].z < 1.31
            and island["materials"].intersection({WIPER_MATERIAL, STATIC_TRIM_MATERIAL})
        )
    ]


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validating")
    marker = bpy.data.objects.get("ES7_WIPER_HIERARCHY_REFINEMENT")
    if marker is None or marker.get("status") != "semantic-wiper-hierarchy-refined":
        fail("hierarchy refinement marker is missing")

    body = bpy.data.objects.get(BODY_NAME)
    if body is None or body.type != "MESH":
        fail("static body mesh is missing")
    static_rows = nearby_static_rows(body)
    fixed_rows = [row for row in static_rows if WIPER_MATERIAL in row["materials"]]
    trim_rows = [row for row in static_rows if STATIC_TRIM_MATERIAL in row["materials"]]
    if len(fixed_rows) != 4 or len(trim_rows) != 1:
        fail(f"unexpected fixed-base/trim island counts: {len(fixed_rows)}/{len(trim_rows)}")

    scene = bpy.context.scene
    centers = {}
    maximum_z = {}
    expected_islands = {"left": 148, "right": 89}
    for frame in (601, 636, 670):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        centers[frame] = {}
        maximum_z[frame] = {}
        for side, (mesh_names, pivot_name, origin) in WIPERS.items():
            meshes = [bpy.data.objects.get(name) for name in mesh_names]
            pivot = bpy.data.objects.get(pivot_name)
            if any(mesh is None for mesh in meshes) or pivot is None:
                fail(f"missing {side} wiper mesh or pivot")
            if any(mesh.parent != pivot for mesh in meshes):
                fail(f"{side} wiper assembly is not parented to {pivot_name}")
            if (pivot.matrix_world.translation - origin).length > 0.0001:
                fail(f"{pivot_name} spindle origin changed")
            used_materials = {
                mesh.data.materials[polygon.material_index].name
                for mesh in meshes
                for polygon in mesh.data.polygons
                if polygon.material_index < len(mesh.data.materials) and mesh.data.materials[polygon.material_index]
            }
            if WIPER_MATERIAL not in used_materials or STATIC_TRIM_MATERIAL in used_materials:
                fail(f"{side} wiper assembly has incorrect moving materials: {sorted(used_materials)}")
            island_count = sum(len(connected_islands(mesh)) for mesh in meshes)
            if frame == 601 and island_count != expected_islands[side]:
                fail(f"{side} wiper assembly island count changed: {island_count}")
            minimum, maximum = assembly_bounds(meshes)
            centers[frame][side] = (minimum + maximum) * 0.5
            maximum_z[frame][side] = maximum.z

    for side in WIPERS:
        displacement = (centers[636][side] - centers[601][side]).length
        round_trip_error = (centers[670][side] - centers[601][side]).length
        center_rise = centers[636][side].z - centers[601][side].z
        top_rise = maximum_z[636][side] - maximum_z[601][side]
        if displacement <= 0.15:
            fail(f"{side} wiper does not sweep meaningfully: {displacement}")
        if round_trip_error > 0.0001:
            fail(f"{side} wiper does not return to rest: {round_trip_error}")
        if center_rise <= 0.0 or top_rise <= 0.0:
            fail(f"{side} wiper does not sweep upward: center/top rise={center_rise}/{top_rise}")
        print(
            f"- {side}: displacement={displacement:.4f} m, "
            f"center/topRise={center_rise:.4f}/{top_rise:.4f} m, "
            f"roundTripError={round_trip_error:.6f} m"
        )

    print("ES7 WIPER HIERARCHY VALIDATION PASS")
    print(f"- moving island counts left/right: {expected_islands['left']}/{expected_islands['right']}")
    print(f"- fixed base/trim island counts: {len(fixed_rows)}/{len(trim_rows)}")


if __name__ == "__main__":
    main()
