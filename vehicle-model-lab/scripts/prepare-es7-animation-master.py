#!/usr/bin/env python3
"""Create the non-destructive ES7 animation master from the audit scene."""

import json
import math
import shutil
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_PATH = LAB_ROOT / "source" / "es7-reference.blend"
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-a0-baseline.blend"
METADATA_PATH = LAB_ROOT / "references" / "es7-cc-by" / "metadata.json"
SOURCE_MAP_PATH = LAB_ROOT / "schema" / "es7-source-map.json"
PREVIEW_PATH = LAB_ROOT / "previews" / "es7-actions" / "a0-master-front45.png"

SOURCE_COLLECTION_ORIGINAL = "REF_ES7_IMPORTED"
SOURCE_COLLECTION = "SOURCE_ES7_LOCKED"
SOURCE_ROOT = "ES7_CC_BY_REFERENCE_ROOT"
WORK_PREFIX = "es7_work__"
UNUSED_STATIC_WHEEL_OBJECTS = {"ES7.001", "Mesh"}


def fail(message):
    raise SystemExit(f"ES7 MASTER PREPARATION FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def move_to_collection(obj, collection):
    for source in list(obj.users_collection):
        source.objects.unlink(obj)
    collection.objects.link(obj)


def create_collection(name):
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    return collection


def remove_collection_with_objects(name):
    collection = bpy.data.collections.get(name)
    if collection is None:
        return
    for obj in list(collection.all_objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.collections.remove(collection)


def world_bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    if not points:
        fail("no mesh bounds are available")
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return minimum, maximum


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def create_material(name, color, roughness=0.4, metallic=0.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = (*color, 1.0)
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    return material


def duplicate_source_objects(source_collection, model_collection, work_root):
    originals = sorted(
        (obj for obj in source_collection.all_objects if obj.name != SOURCE_ROOT),
        key=lambda obj: obj.name,
    )
    duplicates = {}
    for original in originals:
        duplicate = original.copy()
        if original.data is not None:
            duplicate.data = original.data.copy()
        duplicate.name = WORK_PREFIX + original.name
        duplicate["source_object_name"] = original.name
        duplicate["source_author"] = "ItsDiyor"
        duplicate["source_license"] = "CC BY 4.0"
        if original.name in UNUSED_STATIC_WHEEL_OBJECTS:
            duplicate["export_forbidden"] = True
            duplicate["wheel_variant_status"] = "unused-static-wheel-hidden"
            duplicate.hide_render = True
            duplicate.hide_viewport = True
        model_collection.objects.link(duplicate)
        duplicates[original] = duplicate

    for original, duplicate in duplicates.items():
        original_basis = original.matrix_basis.copy()
        original_parent_inverse = original.matrix_parent_inverse.copy()
        duplicate.parent = duplicates.get(original.parent, work_root)
        duplicate.matrix_parent_inverse = (
            original_parent_inverse if original.parent in duplicates else Matrix.Identity(4)
        )
        duplicate.matrix_basis = original_basis
    return duplicates


def source_wheelbase(source_map):
    components = source_map["components"]
    front_y = (
        components["wheel_front_left"]["sourceCenter"][1]
        + components["wheel_front_right"]["sourceCenter"][1]
    ) * 0.5
    rear_y = (
        components["wheel_rear_left"]["sourceCenter"][1]
        + components["wheel_rear_right"]["sourceCenter"][1]
    ) * 0.5
    wheelbase = rear_y - front_y
    if wheelbase <= 0:
        fail(f"invalid source wheelbase {wheelbase}")
    return wheelbase


def normalize_work_model(normalization, work_meshes, target_wheelbase, measured_wheelbase):
    minimum, maximum = world_bounds(work_meshes)
    center = (minimum + maximum) * 0.5
    scale = target_wheelbase / measured_wheelbase
    rotation = Matrix.Rotation(math.pi / 2.0, 4, "Z")
    transformed_center = rotation @ Vector((center.x * scale, center.y * scale, center.z * scale))

    normalization.rotation_euler.z = math.pi / 2.0
    normalization.scale = (scale, scale, scale)
    normalization.location = (-transformed_center.x, -transformed_center.y, -minimum.z * scale)
    normalization["axis_contract"] = "+X front, +Y left, +Z up"
    normalization["source_axis"] = "+X left, +Y rear, +Z up"
    normalization["scale_basis"] = "2960 mm official wheelbase"
    normalization["uniform_scale"] = scale
    return scale


def create_preview_scene(preview_collection, work_meshes):
    bpy.context.view_layer.update()
    minimum, maximum = world_bounds(work_meshes)
    center = (minimum + maximum) * 0.5
    size = maximum - minimum
    distance = max(size.x, size.y) * 1.45

    ground_material = create_material("MAT_ES7_A0_GROUND", (0.035, 0.04, 0.05), roughness=0.3)
    bpy.ops.mesh.primitive_plane_add(size=max(size.x, size.y) * 4.0, location=(0.0, 0.0, -0.006))
    ground = bpy.context.object
    ground.name = "es7_preview_ground"
    move_to_collection(ground, preview_collection)
    ground.data.materials.append(ground_material)

    camera_specs = {
        "ES7_REVIEW_front45": center + Vector((distance, distance * 0.78, size.z * 0.42)),
        "ES7_REVIEW_side": center + Vector((0.0, distance * 1.28, size.z * 0.12)),
        "ES7_REVIEW_rear45": center + Vector((-distance, distance * 0.78, size.z * 0.42)),
    }
    cameras = {}
    for name, location in camera_specs.items():
        bpy.ops.object.camera_add(location=location)
        camera = bpy.context.object
        camera.name = name
        camera.data.lens = 62
        point_at(camera, center + Vector((0.0, 0.0, size.z * 0.03)))
        move_to_collection(camera, preview_collection)
        cameras[name] = camera

    light_specs = (
        ("es7_preview_key", center + Vector((distance * 0.8, -distance * 0.65, size.z * 1.8)), 1450, 5.0),
        ("es7_preview_fill", center + Vector((-distance * 0.5, -distance * 0.7, size.z * 0.9)), 850, 4.0),
        ("es7_preview_rim", center + Vector((-distance * 0.7, distance * 0.65, size.z * 1.4)), 1200, 3.5),
    )
    for name, location, energy, area_size in light_specs:
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.name = name
        light.data.energy = energy
        light.data.shape = "DISK"
        light.data.size = area_size
        point_at(light, center)
        move_to_collection(light, preview_collection)

    return cameras, minimum, maximum


def configure_scene(camera):
    scene = bpy.context.scene
    scene["asset_contract"] = "nio-es7-animation-master@0.1.0"
    scene["asset_status"] = "a0-non-destructive-baseline"
    scene["third_party_author"] = "ItsDiyor"
    scene["third_party_license"] = "CC BY 4.0"
    scene["third_party_source"] = "https://sketchfab.com/3d-models/nio-es7-2023-4d9c574b84514b21ac783aca550793fe"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.filepath = str(PREVIEW_PATH)
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.world.color = (0.025, 0.03, 0.038)
    scene.camera = camera


def main():
    if Path(bpy.data.filepath).resolve() != REFERENCE_PATH.resolve():
        fail(f"open {REFERENCE_PATH} before preparing the master")
    if MASTER_PATH.exists() or CHECKPOINT_PATH.exists():
        fail("master or A0 checkpoint already exists; refusing to overwrite")

    metadata = load_json(METADATA_PATH)
    source_map = load_json(SOURCE_MAP_PATH)
    if source_map.get("status") != "confirmed-by-user-and-blender-selection":
        fail("the ES7 source map has not been confirmed")

    remove_collection_with_objects("REFERENCE_PREVIEW")
    source_collection = bpy.data.collections.get(SOURCE_COLLECTION_ORIGINAL)
    if source_collection is None:
        fail(f"missing {SOURCE_COLLECTION_ORIGINAL}")
    source_collection.name = SOURCE_COLLECTION
    source_collection.hide_viewport = True
    source_collection.hide_render = True
    source_collection["export_forbidden"] = True
    source_collection["purpose"] = "unaltered source evidence"

    source_root = bpy.data.objects.get(SOURCE_ROOT)
    if source_root is None:
        fail(f"missing {SOURCE_ROOT}")
    source_root["export_forbidden"] = True

    model_collection = create_collection("MODEL_ES7")
    rig_collection = create_collection("RIG_COMPONENTS")
    preview_collection = create_collection("LIGHTING_PREVIEW")
    export_collection = create_collection("EXPORT_ONLY")
    preview_collection["export_forbidden"] = True

    vehicle_root = bpy.data.objects.new("vehicle_root", None)
    vehicle_root["contract_role"] = "export_root"
    vehicle_root["source_author"] = "ItsDiyor"
    vehicle_root["source_license"] = "CC BY 4.0"
    vehicle_root["source_url"] = metadata["model"]["pageUrl"]
    export_collection.objects.link(vehicle_root)

    normalization = bpy.data.objects.new("source_normalization", None)
    normalization.parent = vehicle_root
    normalization["contract_role"] = "source_axis_and_scale_normalization"
    rig_collection.objects.link(normalization)

    work_root = bpy.data.objects.new("es7_work_asset_root", None)
    work_root.parent = normalization
    work_root["contract_role"] = "working_geometry_root"
    work_root["source_author"] = "ItsDiyor"
    work_root["source_license"] = "CC BY 4.0"
    model_collection.objects.link(work_root)

    duplicates = duplicate_source_objects(source_collection, model_collection, work_root)
    work_meshes = [duplicate for duplicate in duplicates.values() if duplicate.type == "MESH"]
    measured_wheelbase = source_wheelbase(source_map)
    target_wheelbase = metadata["officialDimensions"]["wheelbaseMm"] / 1000.0
    uniform_scale = normalize_work_model(normalization, work_meshes, target_wheelbase, measured_wheelbase)

    cameras, minimum, maximum = create_preview_scene(preview_collection, work_meshes)
    vehicle_root["official_length_m"] = metadata["officialDimensions"]["lengthMm"] / 1000.0
    vehicle_root["official_width_m"] = metadata["officialDimensions"]["widthMm"] / 1000.0
    vehicle_root["official_height_m"] = metadata["officialDimensions"]["heightMm"] / 1000.0
    vehicle_root["official_wheelbase_m"] = target_wheelbase
    vehicle_root["working_bounds_m"] = [round(value, 6) for value in (maximum - minimum)]
    vehicle_root["uniform_source_scale"] = uniform_scale

    configure_scene(cameras["ES7_REVIEW_front45"])
    PREVIEW_PATH.parent.mkdir(parents=True, exist_ok=True)
    MASTER_PATH.parent.mkdir(parents=True, exist_ok=True)
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))
    shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)

    print("ES7 ANIMATION MASTER PREPARATION PASS")
    print(f"- work objects: {len(duplicates)}")
    print(f"- work meshes: {len(work_meshes)}")
    print(f"- source wheelbase: {measured_wheelbase:.6f} m")
    print(f"- target wheelbase: {target_wheelbase:.6f} m")
    print(f"- uniform scale: {uniform_scale:.9f}")
    print(f"- normalized bounds: {[round(value, 6) for value in (maximum - minimum)]}")
    print(f"- master: {MASTER_PATH}")
    print(f"- checkpoint: {CHECKPOINT_PATH}")
    print(f"- preview: {PREVIEW_PATH}")


if __name__ == "__main__":
    main()
