#!/usr/bin/env python3
"""Export the ES7 Stage-B GLB and derive its component manifest."""

import json
import struct
from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
METADATA_PATH = LAB_ROOT / "references" / "es7-cc-by" / "metadata.json"
DIST_PATH = LAB_ROOT / "dist"
GLB_PATH = DIST_PATH / "nio-es7-animated.glb"
MANIFEST_PATH = DIST_PATH / "nio-es7-component-manifest.json"
SHOWCASE_TRACKS = {"stage_a_showcase", "stage_b_showcase"}


def fail(message):
    raise SystemExit(f"ES7 GLB EXPORT FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_glb_json(path):
    data = path.read_bytes()
    if data[:4] != b"glTF" or struct.unpack_from("<I", data, 4)[0] != 2:
        fail(f"{path} is not a GLB 2.0 file")
    offset = 12
    while offset < len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        if chunk_type == 0x4E4F534A:
            return json.loads(data[offset:offset + chunk_length].decode("utf-8"))
        offset += chunk_length
    fail(f"{path} has no JSON chunk")


def export_objects(schema):
    model_collection = bpy.data.collections.get("MODEL_ES7")
    if not model_collection:
        fail("MODEL_ES7 is missing")
    objects = {obj for obj in model_collection.all_objects if not obj.get("export_forbidden")}

    def add_descendants(obj):
        for child in obj.children:
            if not child.get("export_forbidden"):
                objects.add(child)
                add_descendants(child)

    for component in schema["components"]:
        obj = bpy.data.objects.get(component["nodeName"])
        if not obj:
            fail(f"missing schema node {component['nodeName']}")
        add_descendants(obj)
        while obj:
            objects.add(obj)
            if obj.name == "vehicle_root":
                break
            obj = obj.parent
    forbidden = [obj.name for obj in objects if obj.name.startswith("ES7_STAGE_") or obj.name.startswith("ES7_REVIEW_")]
    if forbidden:
        fail(f"export whitelist contains preview/stage objects: {forbidden}")
    forbidden_assets = [obj.name for obj in objects if obj.get("export_forbidden")]
    if forbidden_assets:
        fail(f"export whitelist contains forbidden assets: {forbidden_assets}")
    return objects


def evaluated_bounds(objects):
    points = []
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for source in objects:
        if source.type != "MESH":
            continue
        obj = source.evaluated_get(depsgraph)
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        fail("export whitelist has no mesh bounds")
    minimum = [min(point[index] for point in points) for index in range(3)]
    maximum = [max(point[index] for point in points) for index in range(3)]
    return {
        "minimumMeters": [round(value, 6) for value in minimum],
        "maximumMeters": [round(value, 6) for value in maximum],
        "sizeMeters": [round(maximum[index] - minimum[index], 6) for index in range(3)],
    }


def asset_statistics(objects):
    mesh_objects = [obj for obj in objects if obj.type == "MESH"]
    triangles = 0
    materials = set()
    images = set()
    for obj in mesh_objects:
        obj.data.calc_loop_triangles()
        triangles += len(obj.data.loop_triangles)
        for material in obj.data.materials:
            if not material:
                continue
            materials.add(material)
            if material.node_tree:
                for node in material.node_tree.nodes:
                    if node.type == "TEX_IMAGE" and node.image:
                        images.add(node.image)
    texture_sizes = sorted({tuple(image.size) for image in images if image.size[0] and image.size[1]})
    return {
        "meshObjects": len(mesh_objects),
        "blenderTriangles": triangles,
        "blenderMaterials": len(materials),
        "blenderTextures": len(images),
        "textureDimensions": [list(size) for size in texture_sizes],
    }


def add_glb_statistics(statistics, gltf):
    triangles = 0
    for mesh in gltf.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            accessor_index = primitive.get("indices", primitive.get("attributes", {}).get("POSITION"))
            triangles += gltf["accessors"][accessor_index]["count"] // 3
    statistics.update({
        "nodes": len(gltf.get("nodes", [])),
        "meshes": len(gltf.get("meshes", [])),
        "triangles": triangles,
        "materials": len(gltf.get("materials", [])),
        "textures": len(gltf.get("images", [])),
        "animationClips": len(gltf.get("animations", [])),
    })
    if triangles != statistics["blenderTriangles"]:
        fail(f"Blender/GLB triangle counts differ: {statistics['blenderTriangles']} / {triangles}")


def component_manifest(schema):
    return {
        component["id"]: {
            "nodeName": component["nodeName"],
            "parent": component["parent"],
            "kind": component["kind"],
            "requiredStageA": bool(component.get("requiredStageA", False)),
            "requiredStageB": bool(component.get("requiredStageB", False)),
            "requiredStageC": bool(component.get("requiredStageC", False)),
        }
        for component in schema["components"]
    }


def animation_manifest(schema, components):
    result = {}
    for action in schema["mechanicalActions"]:
        result[action["clip"]] = {
            "id": action["id"],
            "type": action["type"],
            "axis": action["axis"],
            "range": action["range"],
            "durationSeconds": action["durationSeconds"],
            "loop": bool(action.get("loop", False)),
            "stage": action.get("stage"),
            "control": action.get("control", "toggle"),
            "defaultValue": action.get("defaultValue", 0.0),
            "targets": [
                {
                    "componentId": target["componentId"],
                    "nodeName": components[target["componentId"]]["nodeName"],
                    "direction": target["direction"],
                }
                for target in action["targets"]
            ],
        }
    return result


def light_manifest(schema, components):
    return {
        control["id"]: {
            "materialSemantic": control["materialSemantic"],
            "offEmissive": control["offEmissive"],
            "onEmissive": control["onEmissive"],
            "flashHz": control.get("flashHz"),
            "components": [
                {"componentId": component_id, "nodeName": components[component_id]["nodeName"]}
                for component_id in control["components"]
            ],
        }
        for control in schema["lightControls"]
    }


def build_manifest(schema, metadata, bounds, statistics):
    components = {component["id"]: component for component in schema["components"]}
    dimensions = metadata["officialDimensions"]
    package = metadata["package"]
    return {
        "contract": "nio-es7-component-manifest@1.2.0",
        "assetId": schema["assetId"],
        "assetVersion": "stage-c-seat-0.3.0",
        "modelPath": "./nio-es7-animated.glb",
        "schemaContract": schema["contract"],
        "coordinateSystem": schema["coordinateSystem"],
        "provenance": {
            "author": metadata["model"]["author"],
            "modelUrl": metadata["model"]["pageUrl"],
            "license": metadata["license"]["fullName"],
            "licenseUrl": metadata["license"]["url"],
            "sourceArchiveSha256": package["sha256"],
            "sourceGlbSha256": package["originalFileSha256"],
        },
        "officialDimensionsMillimeters": {
            "length": dimensions["lengthMm"],
            "width": dimensions["widthMm"],
            "height": dimensions["heightMm"],
            "wheelbase": dimensions["wheelbaseMm"],
            "source": dimensions["source"],
        },
        "exportBounds": bounds,
        "statistics": statistics,
        "components": component_manifest(schema),
        "animations": animation_manifest(schema, components),
        "lights": light_manifest(schema, components),
    }


def track_states(objects):
    states = []
    for obj in objects:
        if not obj.animation_data:
            continue
        for track in obj.animation_data.nla_tracks:
            states.append((track, track.mute))
            track.mute = track.name in SHOWCASE_TRACKS
            for strip in track.strips:
                strip.mute = track.name in SHOWCASE_TRACKS
    return states


def restore_track_states(states):
    for track, mute in states:
        track.mute = mute


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before exporting")
    schema = load_json(SCHEMA_PATH)
    metadata = load_json(METADATA_PATH)
    objects = export_objects(schema)
    scene = bpy.context.scene
    scene.frame_set(1)
    bpy.context.view_layer.update()
    bounds = evaluated_bounds(objects)
    statistics = asset_statistics(objects)

    DIST_PATH.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.hide_viewport = False
        obj.hide_render = False
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects["vehicle_root"]
    states = track_states(objects)
    try:
        bpy.ops.export_scene.gltf(
            filepath=str(GLB_PATH),
            export_format="GLB",
            use_selection=True,
            export_apply=False,
            export_animations=True,
            export_animation_mode="ACTIONS",
            export_merge_animation="NLA_TRACK",
            export_frame_range=False,
            export_yup=True,
            export_extras=True,
            export_materials="EXPORT",
        )
    finally:
        restore_track_states(states)
    if not GLB_PATH.exists() or GLB_PATH.stat().st_size == 0:
        fail("Blender did not write the GLB")
    add_glb_statistics(statistics, read_glb_json(GLB_PATH))
    statistics["glbFileSizeBytes"] = GLB_PATH.stat().st_size
    write_json(MANIFEST_PATH, build_manifest(schema, metadata, bounds, statistics))

    print("ES7 GLB EXPORT PASS")
    print(f"- GLB: {GLB_PATH}")
    print(f"- manifest: {MANIFEST_PATH}")
    print(f"- export objects: {len(objects)}")
    print(f"- triangles: {statistics['triangles']}")
    print(f"- materials/textures: {statistics['materials']}/{statistics['textures']}")
    print(f"- GLB bytes: {statistics['glbFileSizeBytes']}")


if __name__ == "__main__":
    main()
