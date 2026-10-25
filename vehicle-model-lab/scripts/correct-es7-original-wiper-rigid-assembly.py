#!/usr/bin/env python3
"""Correct the ES7 long-wiper spindle and restore its original rigid tip parts."""

import filecmp
import shutil
from collections import defaultdict
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector
from mathutils.kdtree import KDTree


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-original-wiper-rigid-regroup.blend"
BODY_NAME = "es7_work__ES7_Body_C"
RIGHT_MESH_NAME = "wiper_right_mesh"
RIGHT_PIVOT_NAME = "wiper_right_pivot"
FALSE_TIP = Vector((1.0835, -0.7190, 1.2610))
RIGHT_SPINDLE = Vector((1.277216, -0.136966, 1.246273))
WIPER_MATERIAL = "1_车身_黑色胶条"
TIP_RADIUS = 0.04
EXPECTED_TIP_ISLANDS = 6
MARKER_NAME = "ES7_ORIGINAL_WIPER_RIGID_ASSEMBLY"
VERTEX_TOLERANCE = 0.00002


def fail(message):
    raise SystemExit(f"ES7 ORIGINAL WIPER RIGID ASSEMBLY FAILED: {message}")


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
            "vertices": vertices,
            "polygons": len(polygons),
            "center": (minimum + maximum) * 0.5,
            "materials": materials,
        })
    return rows


def world_vertices(objects):
    return [
        obj.matrix_world @ vertex.co
        for obj in objects
        for vertex in obj.data.vertices
    ]


def maximum_nearest_distance(source, target):
    tree = KDTree(len(target))
    for index, point in enumerate(target):
        tree.insert(point, index)
    tree.balance()
    return max(tree.find(point)[2] for point in source)


def polygon_count(objects):
    return sum(len(obj.data.polygons) for obj in objects)


def delete_vertices(mesh, indices, delete_selected):
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    vertices = [vertex for vertex in bm.verts if (vertex.index in indices) == delete_selected]
    bmesh.ops.delete(bm, geom=vertices, context="VERTS")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def extract_selection(source, selected, name):
    duplicate = source.copy()
    duplicate.data = source.data.copy()
    duplicate.name = name
    duplicate.data.name = name + "_mesh"
    source.users_collection[0].objects.link(duplicate)
    delete_vertices(duplicate.data, selected, delete_selected=False)
    delete_vertices(source.data, selected, delete_selected=True)
    return duplicate


def relocate_pivot(pivot, origin):
    child_matrices = {child: child.matrix_world.copy() for child in pivot.children}
    matrix_world = pivot.matrix_world.copy()
    matrix_world.translation = origin
    pivot.matrix_world = matrix_world
    bpy.context.view_layer.update()
    for child, child_matrix in child_matrices.items():
        child.matrix_world = child_matrix
    bpy.context.view_layer.update()


def preserve_checkpoint():
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if CHECKPOINT_PATH.exists():
        if not filecmp.cmp(MASTER_PATH, CHECKPOINT_PATH, shallow=False):
            fail(f"checkpoint already exists and does not match current master: {CHECKPOINT_PATH}")
        print(f"- reusing matching checkpoint: {CHECKPOINT_PATH}")
        return
    shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before correcting")
    if bpy.data.objects.get(MARKER_NAME):
        fail("original rigid wiper correction has already been applied")

    scene = bpy.context.scene
    scene.frame_set(601)
    bpy.context.view_layer.update()
    body = bpy.data.objects.get(BODY_NAME)
    right_mesh = bpy.data.objects.get(RIGHT_MESH_NAME)
    right_pivot = bpy.data.objects.get(RIGHT_PIVOT_NAME)
    if body is None or right_mesh is None or right_pivot is None:
        fail("body, right wiper mesh, or right wiper pivot is missing")

    tip_islands = [
        island for island in connected_islands(body)
        if WIPER_MATERIAL in island["materials"]
        and (island["center"] - FALSE_TIP).length < TIP_RADIUS
    ]
    if len(tip_islands) != EXPECTED_TIP_ISLANDS:
        fail(f"expected {EXPECTED_TIP_ISLANDS} rigid tip islands, found {len(tip_islands)}")

    before_objects = (body, right_mesh)
    before_vertices = world_vertices(before_objects)
    before_polygons = polygon_count(before_objects)
    before_materials = {
        obj.name: tuple(material.name for material in obj.data.materials if material)
        for obj in before_objects
    }
    preserve_checkpoint()

    relocate_pivot(right_pivot, RIGHT_SPINDLE)
    selected = set().union(*(island["vertices"] for island in tip_islands))
    tip_part = extract_selection(body, selected, "wiper_right_original_tip_parts")
    tip_world = tip_part.matrix_world.copy()
    tip_part.parent = right_pivot
    tip_part.matrix_world = tip_world
    bpy.context.view_layer.update()

    right_pivot["stage_b_rotation_origin"] = [round(float(value), 6) for value in RIGHT_SPINDLE]
    right_pivot["spindle_source"] = "original-arm-root-cluster-center"
    right_pivot["sweep_radians"] = -1.08
    right_pivot["sweep_direction"] = -1
    right_mesh["hierarchy_role"] = "original-blade-arm-moving-assembly"
    right_mesh["geometry_policy"] = "rigid-original-islands-only"
    tip_part["component_id"] = "wiper_right"
    tip_part["hierarchy_role"] = "original-blade-tip-moving-parts"
    tip_part["geometry_policy"] = "rigid-original-islands-only"

    after_objects = (body, right_mesh, tip_part)
    after_vertices = world_vertices(after_objects)
    if len(after_vertices) != len(before_vertices):
        fail(f"vertex count conservation failed: {len(before_vertices)} -> {len(after_vertices)}")
    forward_error = maximum_nearest_distance(before_vertices, after_vertices)
    reverse_error = maximum_nearest_distance(after_vertices, before_vertices)
    if max(forward_error, reverse_error) > VERTEX_TOLERANCE:
        fail(
            "world-space vertex conservation failed: "
            f"forward={forward_error:.9f}, reverse={reverse_error:.9f}"
        )
    if polygon_count(after_objects) != before_polygons:
        fail("polygon conservation failed")
    for name, materials in before_materials.items():
        obj = bpy.data.objects.get(name)
        if obj is None or not set(materials).issubset({material.name for material in obj.data.materials if material}):
            fail(f"material slots changed unexpectedly on {name}")

    marker = bpy.data.objects.new(MARKER_NAME, None)
    marker["status"] = "original-islands-rigid-chain-with-correct-spindle"
    marker["moved_tip_islands"] = len(tip_islands)
    marker["right_spindle"] = [round(float(value), 6) for value in RIGHT_SPINDLE]
    marker["directions"] = "left-negative-z-right-negative-z"
    marker["vertex_tolerance_meters"] = VERTEX_TOLERANCE
    marker["checkpoint"] = str(CHECKPOINT_PATH.relative_to(LAB_ROOT))
    bpy.data.collections["RIG_COMPONENTS"].objects.link(marker)
    old_marker = bpy.data.objects.get("ES7_DUAL_WIPER_UPWARD_FIX")
    if old_marker:
        old_marker["superseded_by"] = MARKER_NAME
    scene["es7_wiper_hierarchy"] = "original-rigid-assemblies-correct-spindles"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))

    print("ES7 ORIGINAL WIPER RIGID ASSEMBLY PASS")
    print(f"- moved original tip islands: {len(tip_islands)}")
    print(f"- right spindle: {tuple(round(value, 6) for value in RIGHT_SPINDLE)}")
    print(f"- checkpoint: {CHECKPOINT_PATH}")


if __name__ == "__main__":
    main()
