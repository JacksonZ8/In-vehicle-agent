#!/usr/bin/env python3
"""Extract and rig the ES7 Stage-B charge port, mirrors, wipers, and height control."""

import json
import shutil
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-stage-b-components.blend"
AUDIT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "stage-b-component-audit.json"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
STAGE_MARKER = "ES7_STAGE_B_COMPONENT_RIG"
BODY_NAME = "es7_work__ES7_Body_C"
DOOR_NAMES = {
    "left": "es7_work__ES7_Door_LF",
    "right": "es7_work__ES7_Door_RF",
}
CHARGE_ISLANDS = {"island-115", "island-131"}
MIRROR_ISLANDS = {"island-009", "island-011", "island-017", "island-029", "island-036", "island-045"}
WIPER_MATERIALS = {"1_车身_黑色胶条"}
WIPER_LINK_DISTANCE = 0.0125
WIPER_SPINDLES = {
    "left": Vector((1.2165, 0.6922, 1.1930)),
    "right": Vector((1.277216, -0.136966, 1.246273)),
}


def fail(message):
    raise SystemExit(f"ES7 STAGE-B COMPONENT RIG FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def mesh_counts(mesh):
    mesh.calc_loop_triangles()
    return len(mesh.vertices), len(mesh.polygons), len(mesh.loop_triangles)


def adjacency(mesh):
    result = [[] for _ in mesh.vertices]
    for edge in mesh.edges:
        first, second = edge.vertices
        result[first].append(second)
        result[second].append(first)
    return result


def connected_vertices(graph, start_index):
    visited = {start_index}
    stack = [start_index]
    while stack:
        current = stack.pop()
        for neighbor in graph[current]:
            if neighbor not in visited:
                visited.add(neighbor)
                stack.append(neighbor)
    return visited


def audited_vertices(mesh, islands):
    graph = adjacency(mesh)
    selected = set()
    for island in islands:
        vertices = connected_vertices(graph, island["rootVertex"])
        if len(vertices) != island["vertices"]:
            fail(f"{island['islandId']} vertex count changed")
        if selected.intersection(vertices):
            fail(f"{island['islandId']} overlaps another selected island")
        selected.update(vertices)
    return selected


def delete_vertices(mesh, indices, delete_selected):
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    vertices = [vertex for vertex in bm.verts if (vertex.index in indices) == delete_selected]
    bmesh.ops.delete(bm, geom=vertices, context="VERTS")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def extract_groups(source, groups):
    before_vertices, before_polygons, before_triangles = mesh_counts(source.data)
    extracted = {}
    selected_union = set()
    for name, selected in groups.items():
        if not selected:
            fail(f"{name} has no selected vertices")
        if selected_union.intersection(selected):
            fail(f"{name} overlaps another extraction group")
        selected_union.update(selected)
        obj = source.copy()
        obj.data = source.data.copy()
        obj.name = name
        obj.data.name = name + "_mesh"
        obj["source_object_name"] = source.get("source_object_name", source.name)
        obj["source_author"] = "ItsDiyor"
        obj["source_license"] = "CC BY 4.0"
        bpy.data.collections["MODEL_ES7"].objects.link(obj)
        delete_vertices(obj.data, selected, delete_selected=False)
        extracted[name] = obj

    delete_vertices(source.data, selected_union, delete_selected=True)
    remaining = mesh_counts(source.data)
    extracted_counts = [mesh_counts(obj.data) for obj in extracted.values()]
    if remaining[1] + sum(counts[1] for counts in extracted_counts) != before_polygons:
        fail(f"{source.name} polygon conservation failed")
    if remaining[2] + sum(counts[2] for counts in extracted_counts) != before_triangles:
        fail(f"{source.name} triangle conservation failed")
    source["stage_b_source_vertices_before"] = before_vertices
    return extracted


def create_pivot(name, component_id, parent, world_matrix, rig_collection, role):
    if bpy.data.objects.get(name):
        fail(f"pivot already exists: {name}")
    pivot = bpy.data.objects.new(name, None)
    pivot.empty_display_type = "ARROWS"
    pivot.empty_display_size = 0.1
    pivot.rotation_mode = "XYZ"
    rig_collection.objects.link(pivot)
    pivot.parent = parent
    bpy.context.view_layer.update()
    pivot.matrix_world = world_matrix
    bpy.context.view_layer.update()
    pivot["component_id"] = component_id
    pivot["contract_role"] = role
    return pivot


def reparent_preserving_world(obj, parent):
    matrix_world = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_world = matrix_world


def relocate_rotation_origin(obj, world_origin):
    child_world_matrices = {child: child.matrix_world.copy() for child in obj.children}
    old_world = obj.matrix_world.copy()
    new_world = old_world.copy()
    new_world.translation = Vector(world_origin)
    if obj.type == "MESH":
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        obj.data.transform(new_world.inverted() @ old_world)
    obj.matrix_world = new_world
    for child, matrix_world in child_world_matrices.items():
        child.matrix_world = matrix_world
    obj["stage_b_rotation_origin"] = [round(float(value), 6) for value in world_origin]


def suffix(island):
    return island["islandId"].rsplit(":", 1)[-1]


def wiper_candidate(island):
    center = island["worldBounds"]["center"]
    size = island["worldBounds"]["size"]
    materials = {item["name"] for item in island["materials"]}
    return (
        0.95 < center[0] < 1.35
        and 1.20 < center[2] < 1.30
        and size[2] < 0.08
        and max(size[0], size[1]) > 0.15
        and bool(materials.intersection(WIPER_MATERIALS))
    )


def bounds_distance(first, second):
    first_minimum = first["worldBounds"]["minimum"]
    first_maximum = first["worldBounds"]["maximum"]
    second_minimum = second["worldBounds"]["minimum"]
    second_maximum = second["worldBounds"]["maximum"]
    squared = 0.0
    for axis in range(3):
        gap = max(
            first_minimum[axis] - second_maximum[axis],
            second_minimum[axis] - first_maximum[axis],
            0.0,
        )
        squared += gap * gap
    return squared ** 0.5


def in_wiper_region(island):
    center = Vector(island["worldBounds"]["center"])
    materials = {item["name"] for item in island["materials"]}
    return (
        0.95 < center.x < 1.35
        and -0.80 < center.y < 0.80
        and 1.18 < center.z < 1.31
        and bool(materials.intersection(WIPER_MATERIALS))
    )


def is_fixed_spindle_island(island):
    center = Vector(island["worldBounds"]["center"])
    size = Vector(island["worldBounds"]["size"])
    return max(size) < 0.08 and min((center - origin).length for origin in WIPER_SPINDLES.values()) < 0.04


def assign_wiper_islands(islands):
    candidates = [island for island in islands if in_wiper_region(island) and not is_fixed_spindle_island(island)]
    groups = {
        "left": [island for island in candidates if wiper_candidate(island) and island["worldBounds"]["center"][1] > -0.18],
        "right": [island for island in candidates if wiper_candidate(island) and island["worldBounds"]["center"][1] <= -0.18],
    }
    if not groups["left"] or not groups["right"]:
        fail("left or right wiper seed islands are missing")

    assigned = {id(island) for group in groups.values() for island in group}
    pending = [island for island in candidates if id(island) not in assigned]
    while pending:
        additions = {"left": [], "right": []}
        remaining = []
        for island in pending:
            distances = {
                side: min(bounds_distance(island, member) for member in group)
                for side, group in groups.items()
            }
            if abs(distances["left"] - distances["right"]) < 0.001:
                side = "right" if island["worldBounds"]["center"][1] < -0.10 else "left"
            else:
                side = min(distances, key=distances.get)
            if distances[side] <= WIPER_LINK_DISTANCE:
                additions[side].append(island)
            else:
                remaining.append(island)
        if not additions["left"] and not additions["right"]:
            break
        for side in groups:
            groups[side].extend(additions[side])
        pending = remaining
    return groups


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before rigging Stage-B components")
    if bpy.data.objects.get(STAGE_MARKER):
        fail("Stage-B component rig has already been applied")

    audit = load_json(AUDIT_PATH)
    schema = load_json(SCHEMA_PATH)
    components = {component["id"]: component for component in schema["components"]}
    audits = {result["object"]: result for result in audit["objects"]}
    vehicle_root = bpy.data.objects.get("vehicle_root")
    body_static = bpy.data.objects.get("body_static")
    rig_collection = bpy.data.collections.get("RIG_COMPONENTS")
    if not vehicle_root or not body_static or not rig_collection:
        fail("vehicle_root, body_static, or RIG_COMPONENTS is missing")

    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if CHECKPOINT_PATH.exists():
        if CHECKPOINT_PATH.stat().st_size == 0:
            fail(f"checkpoint is empty: {CHECKPOINT_PATH}")
        print(f"- reusing checkpoint: {CHECKPOINT_PATH}")
    else:
        shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)

    body = bpy.data.objects.get(BODY_NAME)
    body_audit = audits.get(BODY_NAME)
    if body is None or body.type != "MESH" or body_audit is None:
        fail(f"missing body mesh or audit: {BODY_NAME}")
    charge_islands = [island for island in body_audit["islands"] if suffix(island) in CHARGE_ISLANDS]
    wiper_groups = assign_wiper_islands(body_audit["islands"])
    wiper_islands = wiper_groups["left"] + wiper_groups["right"]
    if len(charge_islands) != 2 or not wiper_islands:
        fail("charge-port or wiper audit candidates changed")
    left_wiper_islands = wiper_groups["left"]
    right_wiper_islands = wiper_groups["right"]
    body_groups = {
        "charge_port_mesh": audited_vertices(body.data, charge_islands),
        "wiper_left_mesh": audited_vertices(body.data, left_wiper_islands),
        "wiper_right_mesh": audited_vertices(body.data, right_wiper_islands),
    }
    body_parts = extract_groups(body, body_groups)

    charge_mesh = body_parts["charge_port_mesh"]
    charge_minimum, charge_maximum = world_bounds(charge_mesh)
    charge_center = (charge_minimum + charge_maximum) * 0.5
    charge_pivot = create_pivot(
        components["charge_port"]["nodeName"],
        "charge_port",
        body_static,
        Matrix.Translation(Vector((charge_maximum.x, charge_center.y, charge_center.z))),
        rig_collection,
        "right_front_charge_port_hinge",
    )
    charge_pivot["hinge_axis"] = "Z"
    charge_pivot["open_radians"] = 1.48
    charge_mesh["component_id"] = "charge_port"
    reparent_preserving_world(charge_mesh, charge_pivot)

    mirror_parts = {}
    for side, door_name in DOOR_NAMES.items():
        door = bpy.data.objects.get(door_name)
        door_audit = audits.get(door_name)
        if door is None or door.type != "MESH" or door_audit is None:
            fail(f"missing door mesh or audit: {door_name}")
        islands = [island for island in door_audit["islands"] if suffix(island) in MIRROR_ISLANDS]
        if len(islands) != len(MIRROR_ISLANDS):
            fail(f"{door_name} mirror candidates changed")
        part_name = f"mirror_{side}_mesh"
        mirror_parts[side] = extract_groups(door, {part_name: audited_vertices(door.data, islands)})[part_name]

    mirror_config = {
        "left": ("mirror_left_fold", "front_left_door_pivot", Vector((0.86, 0.93, 1.22)), "indicator_front_left", -1.05),
        "right": ("mirror_right_fold", "front_right_door_pivot", Vector((0.86, -0.93, 1.22)), "indicator_front_right", 1.05),
    }
    for side, (component_id, parent_name, origin, indicator_name, angle) in mirror_config.items():
        parent = bpy.data.objects.get(parent_name)
        indicator = bpy.data.objects.get(indicator_name)
        if parent is None or indicator is None:
            fail(f"missing {side} mirror parent or semantic indicator")
        pivot = create_pivot(
            components[component_id]["nodeName"], component_id, parent,
            Matrix.Translation(origin), rig_collection, f"{side}_mirror_fold",
        )
        pivot["hinge_axis"] = "Z"
        pivot["fold_radians"] = angle
        mirror_parts[side]["component_id"] = component_id
        reparent_preserving_world(mirror_parts[side], pivot)
        relocate_rotation_origin(indicator, origin)

    mount_matrix = Matrix.Rotation(0.85, 4, "Y")
    wipers_mount = create_pivot(
        components["wipers_mount"]["nodeName"], "wipers_mount", body_static,
        mount_matrix, rig_collection, "windshield_normal_alignment",
    )
    wiper_config = {
        "left": ("wiper_left", WIPER_SPINDLES["left"], -1.08),
        "right": ("wiper_right", WIPER_SPINDLES["right"], -1.08),
    }
    for side, (component_id, origin, sweep_radians) in wiper_config.items():
        world_matrix = Matrix.Translation(origin) @ Matrix.Rotation(0.85, 4, "Y")
        pivot = create_pivot(
            components[component_id]["nodeName"], component_id, wipers_mount,
            world_matrix, rig_collection, f"{side}_wiper_spindle",
        )
        pivot["sweep_axis"] = "local Z"
        pivot["sweep_radians"] = sweep_radians
        pivot["sweep_direction"] = -1 if sweep_radians < 0.0 else 1
        wiper_mesh = body_parts[f"wiper_{side}_mesh"]
        wiper_mesh["component_id"] = component_id
        reparent_preserving_world(wiper_mesh, pivot)

    suspension = create_pivot(
        components["suspension_height"]["nodeName"], "suspension_height", vehicle_root,
        Matrix.Identity(4), rig_collection, "body_height_control",
    )
    suspension["travel_axis"] = "Z"
    suspension["raise_meters"] = 0.06
    suspension["wheel_nodes_excluded"] = True

    marker = bpy.data.objects.new(STAGE_MARKER, None)
    marker.empty_display_size = 0.08
    marker["stage"] = "B1"
    marker["status"] = "charge-mirrors-wipers-height-rigged"
    marker["charge_islands"] = len(charge_islands)
    marker["mirror_islands_per_side"] = len(MIRROR_ISLANDS)
    marker["wiper_islands"] = len(wiper_islands)
    marker["checkpoint"] = str(CHECKPOINT_PATH.relative_to(LAB_ROOT))
    rig_collection.objects.link(marker)
    bpy.context.scene["es7_rig_stage"] = "B1-components"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))

    print("ES7 STAGE-B COMPONENT RIG PASS")
    print(f"- charge-port islands: {len(charge_islands)}")
    print(f"- mirror islands per side: {len(MIRROR_ISLANDS)}")
    print(f"- wiper islands left/right: {len(left_wiper_islands)}/{len(right_wiper_islands)}")
    print("- suspension travel: +0.06 m with wheels excluded")
    print(f"- checkpoint: {CHECKPOINT_PATH}")


if __name__ == "__main__":
    main()
