#!/usr/bin/env python3
"""Extract ES7 lamp faces into stable semantic light nodes and materials."""

import json
import shutil
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-light-extraction.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
STAGE_MARKER = "ES7_STAGE_A2_LIGHTS"


EXTRACTIONS = (
    {"source": "es7_work__ES7_Body_L", "component": "front_drl_left", "materials": {"2_车灯_前白色"}},
    {"source": "es7_work__ES7_Body_R", "component": "front_drl_right", "materials": {"2_车灯_前白色"}},
    {"source": "es7_work__ES7_Body_L", "component": "low_beam_left", "materials": {"2_车灯_前大灯", "2_车灯_前大灯2"}},
    {"source": "es7_work__ES7_Body_R", "component": "low_beam_right", "materials": {"2_车灯_前大灯", "2_车灯_前大灯2"}},
    {"source": "es7_work__ES7_Body_L", "component": "rear_tail_left", "materials": {"2_车灯_后红色"}},
    {"source": "es7_work__ES7_Body_R", "component": "rear_tail_right", "materials": {"2_车灯_后红色"}},
    {"source": "es7_work__ES7_Door_LF", "component": "indicator_front_left", "materials": {"2_车灯_侧转向"}},
    {"source": "es7_work__ES7_Door_RF", "component": "indicator_front_right", "materials": {"2_车灯_侧转向"}},
    {"source": "es7_work__ES7_Body_L", "component": "indicator_rear_left", "materials": {"2_车灯_后转向"}},
    {"source": "es7_work__ES7_Body_R", "component": "indicator_rear_right", "materials": {"2_车灯_后转向"}},
    {"source": "es7_work__Trunk", "component": "rear_tail_tailgate_left", "materials": {"2_车灯_后红色"}, "side": "left"},
    {"source": "es7_work__Trunk", "component": "rear_tail_tailgate_right", "materials": {"2_车灯_后红色"}, "side": "right"},
    {"source": "es7_work__Trunk", "component": "rear_center_brake", "materials": {"2_车灯_刹车灯"}},
    {"source": "es7_work__Trunk", "component": "indicator_tailgate_left", "materials": {"2_车灯_后转向"}, "side": "left"},
    {"source": "es7_work__Trunk", "component": "indicator_tailgate_right", "materials": {"2_车灯_后转向"}, "side": "right"},
)


COLORS = {
    "es7_light_drl": (0.72, 0.88, 1.0, 1.0),
    "es7_light_low_beam": (0.62, 0.82, 1.0, 1.0),
    "es7_light_tail": (1.0, 0.015, 0.004, 1.0),
    "es7_light_indicator_left": (1.0, 0.18, 0.005, 1.0),
    "es7_light_indicator_right": (1.0, 0.18, 0.005, 1.0),
}


def fail(message):
    raise SystemExit(f"ES7 LIGHT PREPARATION FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def mesh_counts(mesh):
    mesh.calc_loop_triangles()
    return len(mesh.polygons), len(mesh.loop_triangles)


def selected_face_indices(obj, material_names, side=None):
    material_indices = {
        index
        for index, material in enumerate(obj.data.materials)
        if material and material.name in material_names
    }
    if len(material_indices) != len(material_names):
        found = {obj.data.materials[index].name for index in material_indices}
        fail(f"{obj.name} is missing materials {sorted(material_names - found)}")
    selected = set()
    for polygon in obj.data.polygons:
        if polygon.material_index not in material_indices:
            continue
        if side:
            world_center = obj.matrix_world @ polygon.center
            if side == "left" and world_center.y < 0.0:
                continue
            if side == "right" and world_center.y >= 0.0:
                continue
        selected.add(polygon.index)
    if not selected:
        fail(f"{obj.name} has no faces for {sorted(material_names)} side={side}")
    return selected


def delete_faces(mesh, indices, delete_selected):
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.faces.ensure_lookup_table()
    doomed = [face for face in bm.faces if (face.index in indices) == delete_selected]
    bmesh.ops.delete(bm, geom=doomed, context="FACES")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def reparent_preserving_world(obj, parent):
    world = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_world = world


def world_center(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return (minimum + maximum) * 0.5


def principled_node(material):
    material.use_nodes = True
    node = material.node_tree.nodes.get("Principled BSDF")
    if node is None:
        fail(f"{material.name} has no Principled BSDF node")
    return node


def configure_material(material, semantic, color, off_strength, on_strength):
    material.diffuse_color = color
    material["light_semantic"] = semantic
    material["off_emissive"] = float(off_strength)
    material["on_emissive"] = float(on_strength)
    node = principled_node(material)
    base_color = node.inputs.get("Base Color")
    emission_color = node.inputs.get("Emission Color") or node.inputs.get("Emission")
    emission_strength = node.inputs.get("Emission Strength")
    if base_color:
        base_color.default_value = color
    if emission_color:
        emission_color.default_value = color
    if emission_strength:
        emission_strength.default_value = float(off_strength)


def semantic_materials(schema):
    materials = {}
    for control in schema["lightControls"]:
        semantic = control["materialSemantic"]
        if semantic not in COLORS:
            fail(f"no preview color configured for {semantic}")
        if bpy.data.materials.get(semantic):
            fail(f"semantic material already exists: {semantic}")
        material = bpy.data.materials.new(semantic)
        configure_material(
            material,
            semantic,
            COLORS[semantic],
            control["offEmissive"],
            control["onEmissive"],
        )
        materials[semantic] = material
    return materials


def light_control_by_component(schema):
    result = {}
    for control in schema["lightControls"]:
        for component_id in control["components"]:
            if component_id in result:
                fail(f"{component_id} belongs to multiple light controls")
            result[component_id] = control
    return result


def create_light_node(component, parent, collection, location, control):
    name = component["nodeName"]
    if bpy.data.objects.get(name):
        fail(f"light node already exists: {name}")
    node = bpy.data.objects.new(name, None)
    node.empty_display_type = "SPHERE"
    node.empty_display_size = 0.055
    node.parent = parent
    node.matrix_world = Matrix.Translation(location)
    node["component_id"] = component["id"]
    node["contract_role"] = "semantic_light"
    node["light_control"] = control["id"]
    node["material_semantic"] = control["materialSemantic"]
    node["off_emissive"] = float(control["offEmissive"])
    node["on_emissive"] = float(control["onEmissive"])
    if "flashHz" in control:
        node["flash_hz"] = float(control["flashHz"])
    collection.objects.link(node)
    return node


def extract_faces(source, extraction, component, control, material, parent, collection):
    selected = selected_face_indices(source, extraction["materials"], extraction.get("side"))
    before_polygons, before_triangles = mesh_counts(source.data)
    light_mesh = source.copy()
    light_mesh.data = source.data.copy()
    light_mesh.name = component["nodeName"] + "_mesh"
    light_mesh.data.name = light_mesh.name + "_data"
    collection.objects.link(light_mesh)

    delete_faces(light_mesh.data, selected, delete_selected=False)
    delete_faces(source.data, selected, delete_selected=True)
    light_polygons, light_triangles = mesh_counts(light_mesh.data)
    after_polygons, after_triangles = mesh_counts(source.data)
    if light_polygons <= 0 or light_triangles <= 0:
        fail(f"{component['id']} extraction is empty")
    if after_polygons + light_polygons != before_polygons:
        fail(f"{component['id']} polygon conservation failed")
    if after_triangles + light_triangles != before_triangles:
        fail(f"{component['id']} triangle conservation failed")

    light_mesh.data.materials.clear()
    light_mesh.data.materials.append(material)
    for polygon in light_mesh.data.polygons:
        polygon.material_index = 0
    light_mesh["component_id"] = component["id"]
    light_mesh["light_control"] = control["id"]
    light_mesh["material_semantic"] = control["materialSemantic"]
    light_mesh["light_source_object"] = source.name
    light_mesh["extracted_polygons"] = light_polygons
    light_mesh["extracted_triangles"] = light_triangles
    light_mesh["source_author"] = "ItsDiyor"
    light_mesh["source_license"] = "CC BY 4.0"

    node = create_light_node(component, parent, collection, world_center(light_mesh), control)
    reparent_preserving_world(light_mesh, node)
    return light_mesh


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before preparing lights")
    if bpy.data.objects.get(STAGE_MARKER):
        fail("light extraction has already been applied")
    if CHECKPOINT_PATH.exists():
        fail(f"checkpoint already exists: {CHECKPOINT_PATH}")

    schema = load_json(SCHEMA_PATH)
    components = {component["id"]: component for component in schema["components"]}
    controls = light_control_by_component(schema)
    rig_collection = bpy.data.collections.get("RIG_COMPONENTS")
    model_collection = bpy.data.collections.get("MODEL_ES7")
    if not rig_collection or not model_collection:
        fail("RIG_COMPONENTS or MODEL_ES7 is missing")

    sources = {}
    for extraction in EXTRACTIONS:
        component_id = extraction["component"]
        if component_id not in components or component_id not in controls:
            fail(f"schema does not define light component {component_id}")
        source = bpy.data.objects.get(extraction["source"])
        if not source or source.type != "MESH":
            fail(f"missing light source mesh {extraction['source']}")
        sources[source.name] = source

    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)

    original_counts = {name: mesh_counts(source.data) for name, source in sources.items()}
    materials = semantic_materials(schema)
    extracted = []
    for extraction in EXTRACTIONS:
        component = components[extraction["component"]]
        control = controls[component["id"]]
        parent_component = components.get(component["parent"])
        parent_name = parent_component["nodeName"] if parent_component else None
        parent = bpy.data.objects.get(parent_name) if parent_name else None
        if parent is None:
            fail(f"missing parent node {parent_name} for {component['id']}")
        extracted.append(extract_faces(
            sources[extraction["source"]],
            extraction,
            component,
            control,
            materials[control["materialSemantic"]],
            parent,
            model_collection,
        ))

    for name, source in sources.items():
        original_polygons, original_triangles = original_counts[name]
        source["light_split_original_polygons"] = original_polygons
        source["light_split_original_triangles"] = original_triangles
        related = [obj for obj in extracted if obj.get("light_source_object") == name]
        remaining_polygons, remaining_triangles = mesh_counts(source.data)
        if remaining_polygons + sum(obj.get("extracted_polygons") for obj in related) != original_polygons:
            fail(f"{name} final polygon conservation failed")
        if remaining_triangles + sum(obj.get("extracted_triangles") for obj in related) != original_triangles:
            fail(f"{name} final triangle conservation failed")

    marker = bpy.data.objects.new(STAGE_MARKER, None)
    marker.empty_display_size = 0.08
    marker["stage"] = "A2.2"
    marker["status"] = "semantic-light-faces-extracted"
    marker["component_count"] = len(extracted)
    marker["checkpoint"] = str(CHECKPOINT_PATH.relative_to(LAB_ROOT))
    rig_collection.objects.link(marker)
    bpy.context.scene["es7_rig_stage"] = "A2.2-lights"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))

    print("ES7 LIGHT PREPARATION PASS")
    print(f"- semantic light nodes: {len(extracted)}")
    print(f"- semantic materials: {len(materials)}")
    print(f"- checkpoint: {CHECKPOINT_PATH}")


if __name__ == "__main__":
    main()
