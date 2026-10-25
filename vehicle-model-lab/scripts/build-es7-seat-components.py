#!/usr/bin/env python3
"""Build a dry-run ES7 seat candidate or apply the approved seat hierarchy."""

import filecmp
import os
import shutil
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
PREVIEW_DIR = LAB_ROOT / "previews" / "es7-seat-build-candidate"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-seat-components.blend"
BODY_NAME = "es7_work__ES7_Body_C"
BODY_STATIC_NAME = "body_static"
RIG_COLLECTION_NAME = "RIG_COMPONENTS"
MARKER_NAME = "ES7_SEAT_COMPONENTS"
INTERIOR_PREFIX = "0_车内_"
HINGE_X = -0.105
HINGE_Z = 0.785
SEAT_Y = {"left": 0.39514, "right": -0.39513}
REST_BACKREST_ANGLE = -0.14
DRIVER_BASE_ISLANDS = {"010", "114", "121", "122", "124", "125", "143", "149", "150"}
PASSENGER_BASE_ISLANDS = {"011", "055", "098", "100", "115", "116", "118", "123", "126", "127", "142"}
REAR_LEFT_CENTER_ISLANDS = {"026"}
REAR_RIGHT_ISLANDS = {"037"}
VIEWS = {
    "top": ((-0.25, 0.0, 4.1), (-0.18, 0.0, 0.92), 66),
    "left": ((1.75, 2.85, 2.05), (-0.18, 0.12, 0.95), 62),
    "right": ((1.75, -2.85, 2.05), (-0.18, -0.12, 0.95), 62),
    "rear": ((-2.65, 0.0, 1.75), (-0.05, 0.0, 0.98), 66),
}


def fail(message):
    raise SystemExit(f"ES7 SEAT COMPONENT BUILD FAILED: {message}")


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def create_material(name, color, roughness=0.72, metallic=0.0):
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = color
    principled.inputs["Roughness"].default_value = roughness
    principled.inputs["Metallic"].default_value = metallic
    return material


def create_empty(name, parent, location, collection):
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.parent = parent
    obj.location = location
    obj.rotation_mode = "XYZ"
    return obj


def create_rounded_box(name, dimensions, location, bevel, material, parent, collection):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.0))
    obj = bpy.context.object
    obj.name = name
    for original_collection in list(obj.users_collection):
        original_collection.objects.unlink(obj)
    collection.objects.link(obj)
    obj.parent = parent
    obj.location = location
    obj.dimensions = dimensions
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    modifier = obj.modifiers.new("rounded_edges", "BEVEL")
    modifier.width = bevel
    modifier.segments = 4
    modifier.limit_method = "ANGLE"
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def create_support_rod(name, location, material, parent, collection):
    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=0.008, depth=0.13, location=(0.0, 0.0, 0.0))
    obj = bpy.context.object
    obj.name = name
    for original_collection in list(obj.users_collection):
        original_collection.objects.unlink(obj)
    collection.objects.link(obj)
    obj.parent = parent
    obj.location = location
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def build_front_seat(side, parent, collection, materials, candidate=True):
    prefix = "driver" if side == "left" else "passenger"
    suffix = "_candidate" if candidate else ""
    pivot = create_empty(
        f"{prefix}_seat_backrest_pivot{suffix}",
        parent,
        (HINGE_X, SEAT_Y[side], HINGE_Z),
        collection,
    )
    pivot.rotation_euler.y = REST_BACKREST_ANGLE
    leather = materials[f"{side}_leather"]
    insert = materials[f"{side}_insert"]
    metal = materials["metal"]

    core = create_rounded_box(
        f"{prefix}_seat_backrest_core{suffix}",
        (0.115, 0.345, 0.455),
        (0.0, 0.0, 0.255),
        0.052,
        leather,
        pivot,
        collection,
    )
    core.scale.y = 1.0
    create_rounded_box(
        f"{prefix}_seat_backrest_insert{suffix}",
        (0.035, 0.245, 0.325),
        (0.069, 0.0, 0.252),
        0.017,
        insert,
        pivot,
        collection,
    )
    for side_sign, suffix in ((1.0, "left"), (-1.0, "right")):
        bolster = create_rounded_box(
            f"{prefix}_seat_{suffix}_bolster{'_candidate' if candidate else ''}",
            (0.165, 0.075, 0.405),
            (0.016, side_sign * 0.177, 0.235),
            0.034,
            leather,
            pivot,
            collection,
        )
        bolster.rotation_euler.x = side_sign * 0.045

    headrest = create_empty(
        f"{prefix}_seat_headrest_slider{'_candidate' if candidate else ''}",
        pivot,
        (0.0, 0.0, 0.515),
        collection,
    )
    create_rounded_box(
        f"{prefix}_seat_headrest{'_candidate' if candidate else ''}",
        (0.135, 0.285, 0.165),
        (0.0, 0.0, 0.105),
        0.045,
        leather,
        headrest,
        collection,
    )
    create_rounded_box(
        f"{prefix}_seat_headrest_insert{'_candidate' if candidate else ''}",
        (0.025, 0.205, 0.09),
        (0.078, 0.0, 0.105),
        0.012,
        insert,
        headrest,
        collection,
    )
    for side_sign in (-1.0, 1.0):
        create_support_rod(
            f"{prefix}_seat_headrest_rod_{'left' if side_sign > 0 else 'right'}{'_candidate' if candidate else ''}",
            (0.0, side_sign * 0.082, -0.025),
            metal,
            headrest,
            collection,
        )
    return pivot


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


def connected_island_vertices(obj):
    mesh = obj.data
    sets = DisjointSet(len(mesh.vertices))
    for edge in mesh.edges:
        sets.union(edge.vertices[0], edge.vertices[1])
    vertices_by_root = defaultdict(set)
    polygons_by_root = defaultdict(list)
    for vertex in mesh.vertices:
        vertices_by_root[sets.find(vertex.index)].add(vertex.index)
    for polygon in mesh.polygons:
        polygons_by_root[sets.find(polygon.vertices[0])].append(polygon.index)
    rows = []
    for root, vertices in vertices_by_root.items():
        polygons = polygons_by_root.get(root, [])
        if polygons:
            rows.append({"root": root, "vertices": vertices, "polygons": polygons})
    rows.sort(key=lambda item: (-len(item["polygons"]), item["root"]))
    return {f"{index:03d}": item["vertices"] for index, item in enumerate(rows)}


def delete_vertices(mesh, vertex_indices, delete_selected):
    mask = [False] * len(mesh.vertices)
    for index in vertex_indices:
        mask[index] = True
    vertices_to_delete = [
        vertex for vertex in mesh.vertices
        if mask[vertex.index] == delete_selected
    ]
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    mapped = [bm.verts[vertex.index] for vertex in vertices_to_delete]
    bmesh.ops.delete(bm, geom=mapped, context="VERTS")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def extract_groups(source, group_vertices, collection):
    extracted = {}
    selected_union = set().union(*group_vertices.values())
    source.data.calc_loop_triangles()
    before = (len(source.data.vertices), len(source.data.polygons), len(source.data.loop_triangles))
    for name, selected in group_vertices.items():
        obj = source.copy()
        obj.data = source.data.copy()
        obj.name = name
        collection.objects.link(obj)
        delete_vertices(obj.data, selected, delete_selected=False)
        extracted[name] = obj
    delete_vertices(source.data, selected_union, delete_selected=True)
    source.data.calc_loop_triangles()
    for obj in extracted.values():
        obj.data.calc_loop_triangles()
    after = (
        len(source.data.vertices) + sum(len(obj.data.vertices) for obj in extracted.values()),
        len(source.data.polygons) + sum(len(obj.data.polygons) for obj in extracted.values()),
        len(source.data.loop_triangles) + sum(len(obj.data.loop_triangles) for obj in extracted.values()),
    )
    if after != before:
        fail(f"source geometry conservation failed: before={before}, after={after}")
    return extracted, before


def reparent_preserving_world(obj, parent):
    matrix_world = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_world = matrix_world


def duplicate_material_for_focus(obj, polygon, semantic, cache):
    original = obj.data.materials[polygon.material_index]
    if original is None:
        return polygon.material_index
    key = (original.name, semantic)
    if key not in cache:
        duplicate = original.copy()
        duplicate.name = f"seat_focus_{semantic}__{original.name}"
        duplicate["seat_focus_semantic"] = semantic
        obj.data.materials.append(duplicate)
        cache[key] = len(obj.data.materials) - 1
    return cache[key]


def tag_rear_focus_materials(obj, side):
    cache = {}
    for polygon in obj.data.polygons:
        center_local = sum((obj.data.vertices[index].co for index in polygon.vertices), Vector()) / len(polygon.vertices)
        center_world = obj.matrix_world @ center_local
        semantic = f"clear_rear_{side}"
        if side == "left" and center_world.y <= 0.12:
            semantic = "ghost_rear_center"
        polygon.material_index = duplicate_material_for_focus(obj, polygon, semantic, cache)
    obj["seat_focus_group"] = f"rear_{side}"


def preserve_checkpoint():
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if CHECKPOINT_PATH.exists():
        if not filecmp.cmp(MASTER_PATH, CHECKPOINT_PATH, shallow=False):
            fail(f"checkpoint differs from current pre-seat master: {CHECKPOINT_PATH}")
        return
    shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)


def existing_material(name):
    material = bpy.data.materials.get(name)
    if material is None:
        fail(f"missing source material {name}")
    return material


def apply_components(source):
    if bpy.data.objects.get(MARKER_NAME):
        fail("seat components have already been applied")
    body_static = bpy.data.objects.get(BODY_STATIC_NAME)
    rig_collection = bpy.data.collections.get(RIG_COLLECTION_NAME)
    if body_static is None or rig_collection is None:
        fail("missing body_static or RIG_COMPONENTS")
    preserve_checkpoint()
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()

    islands = connected_island_vertices(source)
    requested = DRIVER_BASE_ISLANDS | PASSENGER_BASE_ISLANDS | REAR_LEFT_CENTER_ISLANDS | REAR_RIGHT_ISLANDS
    missing = requested - set(islands)
    if missing:
        fail(f"audited seat islands changed: {sorted(missing)}")
    groups = {
        "driver_seat_base_mesh": set().union(*(islands[index] for index in DRIVER_BASE_ISLANDS)),
        "passenger_seat_base_mesh": set().union(*(islands[index] for index in PASSENGER_BASE_ISLANDS)),
        "rear_left_center_seat_mesh": set().union(*(islands[index] for index in REAR_LEFT_CENTER_ISLANDS)),
        "rear_right_seat_mesh": set().union(*(islands[index] for index in REAR_RIGHT_ISLANDS)),
    }
    extracted, original_counts = extract_groups(source, groups, source.users_collection[0])

    track = create_empty("driver_seat_track_static", body_static, (0.0, 0.0, 0.0), rig_collection)
    fore_aft = create_empty("driver_seat_fore_aft", track, (0.0, 0.0, 0.0), rig_collection)
    height = create_empty("driver_seat_height", fore_aft, (0.0, 0.0, 0.0), rig_collection)
    passenger = create_empty("passenger_seat_static", body_static, (0.0, 0.0, 0.0), rig_collection)
    rear_left = create_empty("rear_left_seat_static", body_static, (0.0, 0.0, 0.0), rig_collection)
    rear_right = create_empty("rear_right_seat_static", body_static, (0.0, 0.0, 0.0), rig_collection)
    reparent_preserving_world(extracted["driver_seat_base_mesh"], height)
    reparent_preserving_world(extracted["passenger_seat_base_mesh"], passenger)
    reparent_preserving_world(extracted["rear_left_center_seat_mesh"], rear_left)
    reparent_preserving_world(extracted["rear_right_seat_mesh"], rear_right)
    extracted["driver_seat_base_mesh"]["seat_focus_group"] = "front_left"
    extracted["passenger_seat_base_mesh"]["seat_focus_group"] = "front_right"
    tag_rear_focus_materials(extracted["rear_left_center_seat_mesh"], "left")
    tag_rear_focus_materials(extracted["rear_right_seat_mesh"], "right")

    materials = {
        "left_leather": existing_material("0_车内_内饰皮革"),
        "left_insert": existing_material("0_车内_翻毛皮"),
        "right_leather": existing_material("0_车内_内饰皮革"),
        "right_insert": existing_material("0_车内_翻毛皮"),
        "metal": existing_material("0_车内_金属"),
    }
    driver_pivot = build_front_seat("left", height, rig_collection, materials, candidate=False)
    passenger_pivot = build_front_seat("right", passenger, rig_collection, materials, candidate=False)
    driver_pivot["seat_focus_group"] = "front_left"
    passenger_pivot["seat_focus_group"] = "front_right"
    for seat_parent, y_value, prefix in ((track, SEAT_Y["left"], "driver"), (passenger, SEAT_Y["right"], "passenger")):
        for y_offset, suffix in ((-0.115, "right"), (0.115, "left")):
            rail = create_rounded_box(
                f"{prefix}_seat_track_{suffix}",
                (0.48, 0.028, 0.026),
                (0.05, y_value + y_offset, 0.675),
                0.008,
                materials["metal"],
                seat_parent,
                rig_collection,
            )
            rail["seat_track_fixed"] = True

    for obj in list(rig_collection.objects):
        if obj.name.startswith(("driver_seat_", "passenger_seat_")):
            if obj.name.startswith("driver_seat_"):
                obj["seat_focus_group"] = "front_left"
            elif obj.name.startswith("passenger_seat_"):
                obj["seat_focus_group"] = "front_right"

    marker = bpy.data.objects.new(MARKER_NAME, None)
    rig_collection.objects.link(marker)
    marker["status"] = "approved-front-seat-backrests-and-four-seat-focus-groups"
    marker["contract"] = "nio-es7-seat-components@0.1.0"
    marker["checkpoint"] = str(CHECKPOINT_PATH.relative_to(LAB_ROOT))
    marker["original_vertices"] = original_counts[0]
    marker["original_polygons"] = original_counts[1]
    marker["original_triangles"] = original_counts[2]
    marker["driver_base_islands"] = sorted(DRIVER_BASE_ISLANDS)
    marker["passenger_base_islands"] = sorted(PASSENGER_BASE_ISLANDS)
    marker["rear_left_center_islands"] = sorted(REAR_LEFT_CENTER_ISLANDS)
    marker["rear_right_islands"] = sorted(REAR_RIGHT_ISLANDS)
    bpy.context.scene["es7_seat_components"] = "front-adjustable-four-seat-focus"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))
    print(f"ES7 SEAT COMPONENTS APPLIED: {MASTER_PATH}")
    print(f"- checkpoint: {CHECKPOINT_PATH}")


def material_name(mesh, polygon):
    if polygon.material_index >= len(mesh.materials) or mesh.materials[polygon.material_index] is None:
        return "<none>"
    return mesh.materials[polygon.material_index].name


def create_interior_context(source, collection, material):
    mesh = source.data
    polygon_indices = [
        polygon.index for polygon in mesh.polygons
        if material_name(mesh, polygon).startswith(INTERIOR_PREFIX)
    ]
    vertex_indices = sorted({index for polygon_index in polygon_indices for index in mesh.polygons[polygon_index].vertices})
    index_map = {old_index: new_index for new_index, old_index in enumerate(vertex_indices)}
    vertices = [mesh.vertices[index].co.copy() for index in vertex_indices]
    faces = [
        [index_map[index] for index in mesh.polygons[polygon_index].vertices]
        for polygon_index in polygon_indices
    ]
    context_mesh = bpy.data.meshes.new("seat_candidate_interior_context_mesh")
    context_mesh.from_pydata(vertices, [], faces)
    context_mesh.materials.append(material)
    context_mesh.update()
    context = bpy.data.objects.new("seat_candidate_interior_context", context_mesh)
    collection.objects.link(context)
    context.matrix_world = source.matrix_world.copy()
    return context


def create_light(name, location, energy, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    point_at(obj, (-0.2, 0.0, 0.95))


def configure_scene(scene):
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 960
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.15
    scene.world.color = (0.012, 0.016, 0.022)


def render_candidate(source, collection):
    for obj in bpy.context.scene.objects:
        if obj.name not in collection.objects:
            obj.hide_render = True
    context_material = create_material("seat_candidate_context", (0.22, 0.28, 0.32, 1.0), roughness=0.82)
    create_interior_context(source, collection, context_material)
    scene = bpy.context.scene
    configure_scene(scene)
    camera_data = bpy.data.cameras.new("ES7_SEAT_BUILD_CAMERA_DATA")
    camera = bpy.data.objects.new("ES7_SEAT_BUILD_CAMERA", camera_data)
    scene.collection.objects.link(camera)
    camera.hide_render = False
    scene.camera = camera
    create_light("ES7_SEAT_BUILD_KEY", (1.7, 1.9, 3.8), 1800, 4.0)
    create_light("ES7_SEAT_BUILD_FILL", (-1.8, -1.6, 2.6), 1050, 3.0)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    for view_name, (location, target, lens) in VIEWS.items():
        camera.location = location
        camera.data.lens = lens
        point_at(camera, target)
        scene.render.filepath = str(PREVIEW_DIR / f"front-seat-candidate-{view_name}.png")
        bpy.ops.render.render(write_still=True)
        print(f"- rendered front-seat-candidate-{view_name}.png")


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before building the seat candidate")
    source = bpy.data.objects.get(BODY_NAME)
    if source is None or source.type != "MESH":
        fail(f"missing fused interior mesh {BODY_NAME}")
    apply_mode = os.environ.get("ES7_SEAT_COMPONENT_APPLY") == "1"
    if apply_mode:
        apply_components(source)
        return
    collection = bpy.data.collections.new("ES7_SEAT_BUILD_CANDIDATE")
    bpy.context.scene.collection.children.link(collection)
    root = create_empty("front_seat_candidate_root", None, (0.0, 0.0, 0.0), collection)
    materials = {
        "left_leather": create_material("seat_candidate_driver_leather", (0.08, 0.88, 0.92, 1.0), 0.58),
        "left_insert": create_material("seat_candidate_driver_insert", (0.025, 0.34, 0.39, 1.0), 0.82),
        "right_leather": create_material("seat_candidate_passenger_leather", (0.96, 0.22, 0.68, 1.0), 0.58),
        "right_insert": create_material("seat_candidate_passenger_insert", (0.42, 0.045, 0.24, 1.0), 0.82),
        "metal": create_material("seat_candidate_metal", (0.34, 0.39, 0.42, 1.0), 0.28, 0.78),
    }
    build_front_seat("left", root, collection, materials)
    build_front_seat("right", root, collection, materials)
    render_candidate(source, collection)
    print("ES7 FRONT-SEAT BUILD CANDIDATE PASS (dry-run)")
    print(f"- hinge X/Z: {HINGE_X:.3f}/{HINGE_Z:.3f} m")
    print(f"- rest backrest angle: {REST_BACKREST_ANGLE:.3f} rad")
    print(f"- previews: {PREVIEW_DIR}")


if __name__ == "__main__":
    main()
