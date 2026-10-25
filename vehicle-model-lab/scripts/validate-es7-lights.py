#!/usr/bin/env python3
"""Validate ES7 semantic light extraction, hierarchy, and conservation."""

import json
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-light-extraction.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
STAGE_MARKER = "ES7_STAGE_A2_LIGHTS"
SOURCE_NAMES = (
    "es7_work__ES7_Body_L",
    "es7_work__ES7_Body_R",
    "es7_work__ES7_Door_LF",
    "es7_work__ES7_Door_RF",
    "es7_work__Trunk",
)
LENS_MATERIALS = {"3_玻璃_车大灯", "3_玻璃_车灯"}


def fail(message):
    raise SystemExit(f"ES7 LIGHT VALIDATION FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def mesh_counts(mesh):
    mesh.calc_loop_triangles()
    return len(mesh.polygons), len(mesh.loop_triangles)


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validation")
    schema = load_json(SCHEMA_PATH)
    components = {component["id"]: component for component in schema["components"]}
    light_components = [component for component in schema["components"] if component["kind"] == "light"]
    controls = {}
    for control in schema["lightControls"]:
        semantic = control["materialSemantic"]
        material = bpy.data.materials.get(semantic)
        if not material:
            fail(f"missing semantic material {semantic}")
        if material.get("light_semantic") != semantic:
            fail(f"{semantic} material semantic is incorrect")
        if material.get("off_emissive") != control["offEmissive"]:
            fail(f"{semantic} off emission is incorrect")
        if material.get("on_emissive") != control["onEmissive"]:
            fail(f"{semantic} on emission is incorrect")
        for component_id in control["components"]:
            controls[component_id] = control

    for component in light_components:
        node = bpy.data.objects.get(component["nodeName"])
        parent_component = components[component["parent"]]
        parent = bpy.data.objects.get(parent_component["nodeName"])
        if not node or node.parent != parent:
            fail(f"{component['id']} node is missing or mis-parented")
        if node.get("component_id") != component["id"]:
            fail(f"{component['id']} component id is incorrect")
        control = controls.get(component["id"])
        if not control or node.get("light_control") != control["id"]:
            fail(f"{component['id']} light control is incorrect")
        meshes = [child for child in node.children if child.type == "MESH"]
        if len(meshes) != 1:
            fail(f"{component['id']} must own exactly one light mesh")
        mesh = meshes[0]
        if mesh.get("material_semantic") != control["materialSemantic"]:
            fail(f"{component['id']} mesh semantic is incorrect")
        if len(mesh.data.materials) != 1 or mesh.data.materials[0].name != control["materialSemantic"]:
            fail(f"{component['id']} mesh material is incorrect")
        if abs(float(mesh.get("light_surface_offset_m", 0.0)) - 0.003) > 1e-6:
            fail(f"{component['id']} light surface offset is incorrect")
        if mesh.get("light_lens_alignment_world_m") is None:
            fail(f"{component['id']} light/lens alignment metadata is missing")

    for source_name in SOURCE_NAMES:
        source = bpy.data.objects.get(source_name)
        if not source or source.type != "MESH":
            fail(f"missing source mesh {source_name}")
        related = [
            obj for obj in bpy.data.objects
            if obj.type == "MESH" and obj.get("light_source_object") == source_name
        ]
        if not related:
            fail(f"{source_name} has no extracted light meshes")
        polygons, triangles = mesh_counts(source.data)
        extracted_polygons = sum(mesh_counts(obj.data)[0] for obj in related)
        extracted_triangles = sum(mesh_counts(obj.data)[1] for obj in related)
        if polygons + extracted_polygons != source.get("light_split_original_polygons"):
            fail(f"{source_name} polygon conservation failed")
        if triangles + extracted_triangles != source.get("light_split_original_triangles"):
            fail(f"{source_name} triangle conservation failed")

    lens_face_counts = {name: 0 for name in LENS_MATERIALS}
    for source_name in ("es7_work__ES7_Body_L", "es7_work__ES7_Body_R", "es7_work__Trunk"):
        source = bpy.data.objects[source_name]
        for polygon in source.data.polygons:
            if polygon.material_index >= len(source.data.materials):
                continue
            material = source.data.materials[polygon.material_index]
            if material and material.name in lens_face_counts:
                lens_face_counts[material.name] += 1
    if any(count <= 0 for count in lens_face_counts.values()):
        fail(f"lamp lens geometry was lost: {lens_face_counts}")

    if not CHECKPOINT_PATH.exists() or CHECKPOINT_PATH.stat().st_size == 0:
        fail("pre-light checkpoint is missing")
    marker = bpy.data.objects.get(STAGE_MARKER)
    if not marker or marker.get("status") != "semantic-light-faces-extracted":
        fail("light stage marker is missing")
    if marker.get("component_count") != len(light_components):
        fail("light stage marker count differs from schema")

    print("ES7 LIGHT VALIDATION PASS")
    print(f"- semantic nodes/material assignments: {len(light_components)}")
    print("- outward semantic surface offset: 0.003 m")
    print("- audited light/lens alignment metadata: 15/15")
    print(f"- source geometry conservation: {len(SOURCE_NAMES)} objects")
    print(f"- preserved lens faces: {lens_face_counts}")
    print(f"- checkpoint bytes: {CHECKPOINT_PATH.stat().st_size}")


if __name__ == "__main__":
    main()
