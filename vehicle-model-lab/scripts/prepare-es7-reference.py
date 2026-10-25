#!/usr/bin/env python3
"""Import the authenticated CC BY ES7 GLB into an isolated audit scene."""

import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import objects_world_bounds as world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
GLB_PATH = LAB_ROOT / "references" / "es7-cc-by" / "working" / "source" / "Untitled.glb"
OUTPUT_BLEND = LAB_ROOT / "source" / "es7-reference.blend"
OUTPUT_PREVIEW = LAB_ROOT / "previews" / "exterior" / "es7-reference-front45.png"


def move_to_collection(obj, collection):
    for source in list(obj.users_collection):
        source.objects.unlink(obj)
    collection.objects.link(obj)


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def create_material(name, color, roughness=0.4):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = (*color, 1.0)
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Roughness"].default_value = roughness
    return material


def main():
    if OUTPUT_BLEND.exists():
        raise SystemExit(f"Refusing to overwrite ES7 reference scene: {OUTPUT_BLEND}")
    if not GLB_PATH.exists():
        raise SystemExit(f"ES7 GLB not found: {GLB_PATH}")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)

    imported_collection = bpy.data.collections.new("REF_ES7_IMPORTED")
    preview_collection = bpy.data.collections.new("REFERENCE_PREVIEW")
    bpy.context.scene.collection.children.link(imported_collection)
    bpy.context.scene.collection.children.link(preview_collection)

    bpy.ops.import_scene.gltf(filepath=str(GLB_PATH), import_pack_images=True)
    imported_objects = list(bpy.context.scene.objects)
    for obj in imported_objects:
        move_to_collection(obj, imported_collection)

    mesh_objects = [obj for obj in imported_objects if obj.type == "MESH"]
    if not mesh_objects:
        raise SystemExit("Imported ES7 GLB contains no mesh objects")

    minimum, maximum = world_bounds(mesh_objects)
    center = (minimum + maximum) * 0.5
    size = maximum - minimum
    root = bpy.data.objects.new("ES7_CC_BY_REFERENCE_ROOT", None)
    root.empty_display_size = max(size) * 0.04
    root["author"] = "ItsDiyor"
    root["license"] = "CC BY 4.0"
    root["source_uid"] = "4d9c574b84514b21ac783aca550793fe"
    imported_collection.objects.link(root)
    for obj in imported_objects:
        if obj.parent is None:
            obj.parent = root

    ground_material = create_material("MAT_ES7_REFERENCE_GROUND", (0.035, 0.04, 0.05), roughness=0.32)
    ground_size = max(size.x, size.y) * 4.0
    bpy.ops.mesh.primitive_plane_add(size=ground_size, location=(center.x, center.y, minimum.z - 0.002))
    ground = bpy.context.object
    ground.name = "reference_ground"
    move_to_collection(ground, preview_collection)
    ground.data.materials.append(ground_material)

    horizontal_long = max(size.x, size.y)
    if size.x >= size.y:
        camera_location = center + Vector((horizontal_long * 1.35, -horizontal_long * 1.35, size.z * 0.75))
    else:
        camera_location = center + Vector((-horizontal_long * 1.35, horizontal_long * 1.35, size.z * 0.75))
    bpy.ops.object.camera_add(location=camera_location)
    camera = bpy.context.object
    camera.name = "ES7_REFERENCE_CAMERA_front45"
    camera.data.lens = 62
    point_at(camera, center + Vector((0, 0, size.z * 0.05)))
    move_to_collection(camera, preview_collection)
    bpy.context.scene.camera = camera

    for name, offset, energy, area_size in (
        ("reference_key", (1.2, -1.0, 1.5), 1450, 5.0),
        ("reference_fill", (-0.8, -0.8, 0.8), 850, 4.0),
        ("reference_rim", (-1.0, 1.0, 1.2), 1200, 3.5),
    ):
        location = center + Vector((offset[0] * horizontal_long, offset[1] * horizontal_long, offset[2] * max(size.z, 1.0)))
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.name = name
        light.data.energy = energy
        light.data.shape = "DISK"
        light.data.size = area_size
        point_at(light, center)
        move_to_collection(light, preview_collection)

    scene = bpy.context.scene
    scene["reference_contract"] = "nio-es7-cc-by-reference@0.1.0"
    scene["export_forbidden"] = True
    scene.unit_settings.system = "METRIC"
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(OUTPUT_PREVIEW)
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.world.color = (0.025, 0.03, 0.038)

    triangle_count = 0
    vertex_count = 0
    for obj in mesh_objects:
        vertex_count += len(obj.data.vertices)
        obj.data.calc_loop_triangles()
        triangle_count += len(obj.data.loop_triangles)

    report = {
        "meshObjects": len(mesh_objects),
        "objects": len(imported_objects),
        "vertices": vertex_count,
        "triangles": triangle_count,
        "materials": len(bpy.data.materials) - 1,
        "images": len(bpy.data.images),
        "boundsMin": [round(value, 6) for value in minimum],
        "boundsMax": [round(value, 6) for value in maximum],
        "dimensions": [round(value, 6) for value in size],
    }

    OUTPUT_BLEND.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT_BLEND))
    bpy.ops.render.render(write_still=True)
    print("ES7_REFERENCE_REPORT=" + json.dumps(report, ensure_ascii=False, sort_keys=True))
    print(f"Saved isolated ES7 reference: {OUTPUT_BLEND}")


if __name__ == "__main__":
    main()
