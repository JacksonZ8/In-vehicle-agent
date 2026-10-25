#!/usr/bin/env python3
"""Extract the two connected hood islands and bind them to a stable pivot."""

import json
import shutil
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import objects_world_bounds as world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-hood-extraction.blend"
AUDIT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "body-island-audit.json"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
BODY_NAMES = ("es7_work__ES7_Body_L", "es7_work__ES7_Body_R")
HOOD_ISLAND_SUFFIX = "island-007"
HOOD_OBJECT_NAMES = ("hood_mesh_left", "hood_mesh_right")
STAGE_MARKER = "ES7_STAGE_A1_HOOD_RIG"


def fail(message):
    raise SystemExit(f"ES7 HOOD EXTRACTION FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def connected_vertices(mesh, start_index):
    adjacency = [[] for _ in mesh.vertices]
    for edge in mesh.edges:
        first, second = edge.vertices
        adjacency[first].append(second)
        adjacency[second].append(first)
    visited = {start_index}
    stack = [start_index]
    while stack:
        current = stack.pop()
        for neighbor in adjacency[current]:
            if neighbor not in visited:
                visited.add(neighbor)
                stack.append(neighbor)
    return visited


def mesh_counts(mesh):
    mesh.calc_loop_triangles()
    return len(mesh.vertices), len(mesh.polygons), len(mesh.loop_triangles)


def delete_vertices(mesh, indices, delete_selected):
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    selected = [
        vertex
        for vertex in bm.verts
        if (vertex.index in indices) == delete_selected
    ]
    bmesh.ops.delete(bm, geom=selected, context="VERTS")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def reparent_preserving_world(obj, parent):
    matrix_world = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_world = matrix_world


def create_hood_half(body, object_name, island):
    root_vertex = island["rootVertex"]
    island_vertices = connected_vertices(body.data, root_vertex)
    if len(island_vertices) != island["vertices"]:
        fail(f"{body.name} hood vertex count changed")

    before_vertices, before_polygons, before_triangles = mesh_counts(body.data)
    hood = body.copy()
    hood.data = body.data.copy()
    hood.name = object_name
    hood.data.name = object_name + "_mesh"
    hood["component_id"] = "hood"
    hood["source_object_name"] = body.get("source_object_name", body.name)
    hood["source_author"] = "ItsDiyor"
    hood["source_license"] = "CC BY 4.0"
    bpy.data.collections["MODEL_ES7"].objects.link(hood)

    delete_vertices(hood.data, island_vertices, delete_selected=False)
    delete_vertices(body.data, island_vertices, delete_selected=True)
    hood_vertices, hood_polygons, hood_triangles = mesh_counts(hood.data)
    remaining_vertices, remaining_polygons, remaining_triangles = mesh_counts(body.data)

    if hood_vertices != island["vertices"] or hood_polygons != island["polygons"]:
        fail(f"{body.name} extracted hood counts do not match the island audit")
    if remaining_polygons + hood_polygons != before_polygons:
        fail(f"{body.name} polygon conservation failed")
    if remaining_triangles + hood_triangles != before_triangles:
        fail(f"{body.name} triangle conservation failed")
    hood["extracted_vertices"] = hood_vertices
    hood["extracted_polygons"] = hood_polygons
    hood["extracted_triangles"] = hood_triangles
    return hood


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before extracting the hood")
    if bpy.data.objects.get(STAGE_MARKER):
        fail("hood extraction has already been applied")
    if CHECKPOINT_PATH.exists():
        fail(f"checkpoint already exists: {CHECKPOINT_PATH}")

    audit = load_json(AUDIT_PATH)
    schema = load_json(SCHEMA_PATH)
    components = {component["id"]: component for component in schema["components"]}
    hood_candidates = {}
    for result in audit["objects"]:
        candidates = [
            island for island in result["islands"]
            if island["islandId"].endswith(HOOD_ISLAND_SUFFIX)
        ]
        if len(candidates) != 1:
            fail(f"{result['object']} does not have exactly one hood candidate")
        candidate = candidates[0]
        if candidate["materials"] != [{"name": "1_车身_车漆", "polygons": 1088}]:
            fail(f"{result['object']} hood material evidence changed")
        hood_candidates[result["object"]] = candidate

    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)

    bodies = []
    hood_halves = []
    for body_name, hood_name in zip(BODY_NAMES, HOOD_OBJECT_NAMES):
        body = bpy.data.objects.get(body_name)
        if body is None or body.type != "MESH":
            fail(f"missing body mesh {body_name}")
        bodies.append(body)
        hood_halves.append(create_hood_half(body, hood_name, hood_candidates[body_name]))

    minimum, maximum = world_bounds(hood_halves)
    vehicle_root = bpy.data.objects.get("vehicle_root")
    rig_collection = bpy.data.collections.get("RIG_COMPONENTS")
    if not vehicle_root or not rig_collection:
        fail("vehicle_root or RIG_COMPONENTS is missing")
    pivot_name = components["hood"]["nodeName"]
    if bpy.data.objects.get(pivot_name):
        fail(f"pivot already exists: {pivot_name}")
    pivot = bpy.data.objects.new(pivot_name, None)
    pivot.empty_display_type = "ARROWS"
    pivot.empty_display_size = 0.14
    pivot.rotation_mode = "XYZ"
    rig_collection.objects.link(pivot)
    pivot.parent = vehicle_root
    bpy.context.view_layer.update()
    pivot.matrix_world = Matrix.Translation(Vector((minimum.x + 0.015, 0.0, maximum.z - 0.02)))
    bpy.context.view_layer.update()
    pivot["component_id"] = "hood"
    pivot["contract_role"] = "hood_hinge"
    pivot["hinge_axis"] = "Y"
    pivot["open_radians"] = 0.78
    pivot["closed_rotation_euler"] = [0.0, 0.0, 0.0]
    for hood in hood_halves:
        reparent_preserving_world(hood, pivot)

    marker = bpy.data.objects.new(STAGE_MARKER, None)
    marker.empty_display_size = 0.08
    marker["stage"] = "A1.3"
    marker["status"] = "hood-islands-extracted-and-rigged"
    marker["hood_objects"] = list(HOOD_OBJECT_NAMES)
    marker["checkpoint"] = str(CHECKPOINT_PATH.relative_to(LAB_ROOT))
    rig_collection.objects.link(marker)

    bpy.context.scene["es7_rig_stage"] = "A1.3-hood"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))
    print("ES7 HOOD EXTRACTION PASS")
    print("- hood halves: 2")
    print("- vertices per half: 594")
    print("- polygons per half: 1088")
    print(f"- pivot: {pivot.name}")
    print(f"- checkpoint: {CHECKPOINT_PATH}")


if __name__ == "__main__":
    main()
