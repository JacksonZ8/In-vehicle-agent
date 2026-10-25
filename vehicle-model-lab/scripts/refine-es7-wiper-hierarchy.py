#!/usr/bin/env python3
"""Refine ES7 wiper island ownership and spindle origins on the current master."""

import os
import shutil
from collections import defaultdict
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-wiper-hierarchy-refinement.blend"
BODY_NAME = "es7_work__ES7_Body_C"
WIPER_NAMES = {"left": "wiper_left_mesh", "right": "wiper_right_mesh"}
PIVOT_NAMES = {"left": "wiper_left_pivot", "right": "wiper_right_pivot"}
SPINDLES = {
    "left": Vector((1.2165, 0.6922, 1.1930)),
    "right": Vector((1.277216, -0.136966, 1.246273)),
}
WIPER_MATERIAL = "1_车身_黑色胶条"
LINK_DISTANCE = 0.0125
MARKER_NAME = "ES7_WIPER_HIERARCHY_REFINEMENT"


def fail(message):
    raise SystemExit(f"ES7 WIPER HIERARCHY REFINEMENT FAILED: {message}")


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
    result = []
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
        result.append({
            "vertices": vertices,
            "polygons": len(polygons),
            "minimum": minimum,
            "maximum": maximum,
            "center": (minimum + maximum) * 0.5,
            "size": maximum - minimum,
            "materials": materials,
        })
    return result


def bounds_distance(first, second):
    squared = 0.0
    for axis in range(3):
        gap = max(
            first["minimum"][axis] - second["maximum"][axis],
            second["minimum"][axis] - first["maximum"][axis],
            0.0,
        )
        squared += gap * gap
    return squared ** 0.5


def in_wiper_region(island):
    center = island["center"]
    return (
        0.95 < center.x < 1.35
        and -0.80 < center.y < 0.80
        and 1.18 < center.z < 1.31
        and WIPER_MATERIAL in island["materials"]
    )


def fixed_spindle_island(island):
    return max(island["size"]) < 0.08 and min(
        (island["center"] - origin).length for origin in SPINDLES.values()
    ) < 0.04


def moving_reference_islands(obj):
    return [
        island for island in connected_islands(obj)
        if WIPER_MATERIAL in island["materials"]
    ]


def assign_body_islands(body, references):
    pending = [
        island for island in connected_islands(body)
        if in_wiper_region(island) and not fixed_spindle_island(island)
    ]
    groups = {side: list(rows) for side, rows in references.items()}
    selected = {"left": [], "right": []}
    ambiguous = []
    while pending:
        additions = {"left": [], "right": []}
        remaining = []
        for island in pending:
            distances = {
                side: min(bounds_distance(island, member) for member in members)
                for side, members in groups.items()
            }
            near_tie = abs(distances["left"] - distances["right"]) < 0.001
            if near_tie:
                side = "right" if island["center"].y < -0.10 else "left"
            else:
                side = min(distances, key=distances.get)
            if distances[side] <= LINK_DISTANCE:
                additions[side].append(island)
                if near_tie:
                    ambiguous.append(island)
            else:
                remaining.append(island)
        if not additions["left"] and not additions["right"]:
            break
        for side in groups:
            groups[side].extend(additions[side])
            selected[side].extend(additions[side])
        pending = remaining
    return selected, pending, ambiguous


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
    if not selected:
        return None
    duplicate = source.copy()
    duplicate.data = source.data.copy()
    duplicate.name = name
    duplicate.data.name = name + "_mesh"
    source.users_collection[0].objects.link(duplicate)
    delete_vertices(duplicate.data, selected, delete_selected=False)
    delete_vertices(source.data, selected, delete_selected=True)
    return duplicate


def extract_groups(source, groups):
    extracted = {}
    selected_union = set()
    for name, selected in groups.items():
        if not selected:
            fail(f"empty extraction group: {name}")
        if selected_union.intersection(selected):
            fail(f"overlapping extraction group: {name}")
        selected_union.update(selected)
        duplicate = source.copy()
        duplicate.data = source.data.copy()
        duplicate.name = name
        duplicate.data.name = name + "_mesh"
        source.users_collection[0].objects.link(duplicate)
        delete_vertices(duplicate.data, selected, delete_selected=False)
        extracted[name] = duplicate
    delete_vertices(source.data, selected_union, delete_selected=True)
    return extracted


def join_into(target, source):
    if source is None:
        return
    bpy.ops.object.select_all(action="DESELECT")
    target.select_set(True)
    source.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.join()


def relocate_pivot(pivot, origin):
    child_matrices = {child: child.matrix_world.copy() for child in pivot.children}
    matrix_world = pivot.matrix_world.copy()
    matrix_world.translation = origin
    pivot.matrix_world = matrix_world
    bpy.context.view_layer.update()
    for child, child_matrix in child_matrices.items():
        child.matrix_world = child_matrix
    pivot["stage_b_rotation_origin"] = [round(float(value), 6) for value in origin]
    pivot["spindle_source"] = "fixed-base-cluster-center"


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before refining")
    if bpy.data.objects.get(MARKER_NAME):
        fail("wiper hierarchy refinement has already been applied")
    dry_run = os.environ.get("ES7_WIPER_REFINE_DRY_RUN") == "1"
    scene = bpy.context.scene
    scene.frame_set(601)
    bpy.context.view_layer.update()

    body = bpy.data.objects.get(BODY_NAME)
    wipers = {side: bpy.data.objects.get(name) for side, name in WIPER_NAMES.items()}
    pivots = {side: bpy.data.objects.get(name) for side, name in PIVOT_NAMES.items()}
    if body is None or any(obj is None for obj in wipers.values()) or any(obj is None for obj in pivots.values()):
        fail("body, wiper mesh, or pivot is missing")

    references = {side: moving_reference_islands(obj) for side, obj in wipers.items()}
    fixed_base_islands = [
        island for island in connected_islands(body)
        if in_wiper_region(island) and fixed_spindle_island(island)
    ]
    selected, unassigned, ambiguous = assign_body_islands(body, references)
    static_from_wipers = {
        side: [island for island in connected_islands(obj) if WIPER_MATERIAL not in island["materials"]]
        for side, obj in wipers.items()
    }
    print(
        "- moving additions left/right: "
        f"{len(selected['left'])}/{len(selected['right'])} islands, "
        f"{sum(item['polygons'] for item in selected['left'])}/"
        f"{sum(item['polygons'] for item in selected['right'])} polygons"
    )
    print(f"- retained static nearby islands: {len(unassigned)}")
    print(f"- fixed spindle islands: {len(fixed_base_islands)}")
    print(f"- near-tie assignments: {len(ambiguous)}")
    for island in ambiguous:
        print(
            "  - near-tie center/size: "
            f"{tuple(round(value, 4) for value in island['center'])} / "
            f"{tuple(round(value, 4) for value in island['size'])}"
        )
    print(
        "- non-rubber islands returned to body left/right: "
        f"{len(static_from_wipers['left'])}/{len(static_from_wipers['right'])}"
    )
    if dry_run:
        print("ES7 WIPER HIERARCHY REFINEMENT DRY RUN PASS")
        return

    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not CHECKPOINT_PATH.exists():
        shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)

    body_indices = {
        f"wiper_{side}_moving_additions": set().union(*(island["vertices"] for island in islands))
        for side, islands in selected.items()
    }
    additions = extract_groups(body, body_indices)

    static_returns = {}
    for side, islands in static_from_wipers.items():
        indices = set().union(*(island["vertices"] for island in islands)) if islands else set()
        static_returns[side] = extract_selection(wipers[side], indices, f"wiper_{side}_static_return")

    for side in ("left", "right"):
        join_into(wipers[side], additions[f"wiper_{side}_moving_additions"])
        join_into(body, static_returns[side])

    for side in ("left", "right"):
        relocate_pivot(pivots[side], SPINDLES[side])
        wipers[side]["hierarchy_role"] = "blade-arm-moving-assembly"
        pivots[side]["fixed_base_excluded"] = True

    marker = bpy.data.objects.new(MARKER_NAME, None)
    marker["status"] = "semantic-wiper-hierarchy-refined"
    marker["link_distance_meters"] = LINK_DISTANCE
    marker["left_added_islands"] = len(selected["left"])
    marker["right_added_islands"] = len(selected["right"])
    marker["retained_static_islands"] = len(unassigned)
    marker["fixed_spindle_islands"] = len(fixed_base_islands)
    marker["near_tie_assignments"] = len(ambiguous)
    marker["checkpoint"] = str(CHECKPOINT_PATH.relative_to(LAB_ROOT))
    bpy.data.collections["RIG_COMPONENTS"].objects.link(marker)
    scene["es7_wiper_hierarchy"] = "semantic-moving-assembly-with-fixed-base"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))
    print("ES7 WIPER HIERARCHY REFINEMENT PASS")
    print(f"- checkpoint: {CHECKPOINT_PATH}")


if __name__ == "__main__":
    main()
