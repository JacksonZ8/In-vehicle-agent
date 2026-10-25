#!/usr/bin/env python3
"""Audit the isolated ES7 reference scene and emit a deterministic candidate source map.

The user-confirmed schema/es7-source-map.json is never written by this audit.
"""

import json
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from es7_lab_common import world_bounds


LAB_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_PATH = LAB_ROOT / "source" / "es7-reference.blend"
AUDIT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "component-audit.json"
CONFIRMED_SOURCE_MAP_PATH = LAB_ROOT / "schema" / "es7-source-map.json"
CANDIDATE_SOURCE_MAP_PATH = LAB_ROOT / "references" / "es7-cc-by" / "es7-source-map.candidate.json"
SOURCE_COLLECTION = "REF_ES7_IMPORTED"
SOURCE_ROOT = "ES7_CC_BY_REFERENCE_ROOT"


DOOR_OBJECTS = {
    "front_left_door": "ES7_Door_LF",
    "front_right_door": "ES7_Door_RF",
    "rear_left_door": "ES7_Door_LB",
    "rear_right_door": "ES7_Door_RB",
}

WINDOW_OBJECTS = {
    "front_left_window": "ES7_DoorGlass_LF",
    "front_right_window": "ES7_DoorGlass_RF",
    "rear_left_window": "ES7_DoorGlass_LB",
    "rear_right_window": "ES7_DoorGlass_RB",
}

HANDLE_OBJECTS = {
    "front_left_handle": "ES7_Doorknob_LF",
    "front_right_handle": "ES7_Doorknob_RF",
    "rear_left_handle": "ES7_Doorknob_LB",
    "rear_right_handle": "ES7_Doorknob_RB",
}

HANDLE_LIGHT_OBJECTS = {
    "front_left_handle_light": "ES7_DoorLight_LF",
    "front_right_handle_light": "ES7_DoorLight_RF",
    "rear_left_handle_light": "ES7_DoorLight_LB",
    "rear_right_handle_light": "ES7_DoorLight_RB",
}

WHEEL_OBJECTS = {
    "wheel_front_left": {"wheel": "Wheel1_3", "caliper": "WheelCaliper_LF"},
    "wheel_front_right": {"wheel": "Wheel1_1", "caliper": "WheelCaliper_RF"},
    "wheel_rear_left": {"wheel": "Wheel1_2", "caliper": "WheelCaliper_LB"},
    "wheel_rear_right": {"wheel": "Wheel1", "caliper": "WheelCaliper_RB"},
}


def fail(message):
    raise SystemExit(f"ES7 COMPONENT AUDIT FAILED: {message}")


def rounded(values):
    return [round(float(value), 6) for value in values]


def serialize_object(obj):
    value = {
        "name": obj.name,
        "type": obj.type,
        "parent": obj.parent.name if obj.parent else None,
        "collections": sorted(collection.name for collection in obj.users_collection),
        "hiddenViewport": bool(obj.hide_viewport),
        "hiddenRender": bool(obj.hide_render),
        "localTransform": {
            "location": rounded(obj.location),
            "rotationQuaternion": rounded(obj.rotation_euler.to_quaternion()),
            "scale": rounded(obj.scale),
        },
        "worldLocation": rounded(obj.matrix_world.translation),
    }
    if obj.type != "MESH":
        return value

    obj.data.calc_loop_triangles()
    minimum, maximum = world_bounds(obj)
    value.update({
        "mesh": {
            "vertices": len(obj.data.vertices),
            "polygons": len(obj.data.polygons),
            "triangles": len(obj.data.loop_triangles),
            "materials": [slot.name if slot else None for slot in obj.data.materials],
        },
        "worldBounds": {
            "minimum": rounded(minimum),
            "maximum": rounded(maximum),
            "center": rounded((minimum + maximum) * 0.5),
            "size": rounded(maximum - minimum),
        },
    })
    return value


def require_objects(names):
    missing = sorted(name for name in names if bpy.data.objects.get(name) is None)
    if missing:
        fail(f"missing mapped objects: {', '.join(missing)}")


def mapped_object_names():
    names = set(DOOR_OBJECTS.values())
    names.update(WINDOW_OBJECTS.values())
    names.update(HANDLE_OBJECTS.values())
    names.update(HANDLE_LIGHT_OBJECTS.values())
    names.add("Trunk")
    for wheel in WHEEL_OBJECTS.values():
        names.update(wheel.values())
    names.update(("ES7_Body_L", "ES7_Body_R"))
    return names


def separated_component(component_id, source_object, kind, evidence):
    return {
        "componentId": component_id,
        "kind": kind,
        "status": "separated-source-object",
        "sourceObjects": [source_object],
        "selectionMode": "whole-object",
        "evidence": evidence,
    }


def build_candidates():
    candidates = []
    for component_id, source_object in DOOR_OBJECTS.items():
        candidates.append(separated_component(
            component_id,
            source_object,
            "door",
            "Dedicated ES7_Door_* mesh in the authenticated source asset.",
        ))
    for component_id, source_object in WINDOW_OBJECTS.items():
        candidates.append(separated_component(
            component_id,
            source_object,
            "window",
            "Dedicated ES7_DoorGlass_* mesh using the matching door-glass material.",
        ))
    for component_id, source_object in HANDLE_OBJECTS.items():
        candidates.append(separated_component(
            component_id,
            source_object,
            "handle",
            "Dedicated ES7_Doorknob_* mesh parented to the matching source door.",
        ))
    for component_id, source_object in HANDLE_LIGHT_OBJECTS.items():
        candidates.append(separated_component(
            component_id,
            source_object,
            "handle-light",
            "Dedicated ES7_DoorLight_* mesh using the handle-light material.",
        ))

    candidates.append(separated_component(
        "tailgate",
        "Trunk",
        "tailgate",
        "Dedicated Trunk mesh containing the liftgate exterior, glazing, trim, and rear lamp materials.",
    ))

    for component_id, source_objects in WHEEL_OBJECTS.items():
        wheel = bpy.data.objects[source_objects["wheel"]]
        caliper = bpy.data.objects[source_objects["caliper"]]
        candidates.append({
            "componentId": component_id,
            "kind": "wheel",
            "status": "separated-source-objects",
            "sourceObjects": [wheel.name, caliper.name],
            "selectionMode": "whole-object-with-material-segmentation",
            "sourceCenter": rounded(world_bounds(wheel)[0].lerp(world_bounds(wheel)[1], 0.5)),
            "caliperCenter": rounded(world_bounds(caliper)[0].lerp(world_bounds(caliper)[1], 0.5)),
            "evidence": "Wheel position and LF/RF/LB/RB caliper label agree; wheel internals still require material-based spin/caliper separation.",
        })

    candidates.extend((
        {
            "componentId": "hood",
            "kind": "hood",
            "status": "requires-working-copy-extraction",
            "sourceObjects": ["ES7_Body_L", "ES7_Body_R"],
            "selectionMode": "mesh-boundary-extraction",
            "evidence": "No dedicated hood object exists; the exterior body halves contain the hood surface.",
        },
        {
            "componentId": "front_lights",
            "kind": "light-group",
            "status": "requires-working-copy-material-segmentation",
            "sourceObjects": ["ES7_Body_L", "ES7_Body_R"],
            "selectionMode": "material-segmentation",
            "materialCandidates": [
                "2_车灯_前白色",
                "2_车灯_侧白色",
                "2_车灯_前大灯",
                "2_车灯_前大灯2",
                "3_玻璃_车大灯",
                "3_玻璃_车灯",
            ],
            "evidence": "Front-light materials exist on both exterior body halves, but no dedicated lamp mesh exists.",
        },
        {
            "componentId": "rear_lights",
            "kind": "light-group",
            "status": "requires-working-copy-material-segmentation",
            "sourceObjects": ["Trunk", "ES7_Body_L", "ES7_Body_R"],
            "selectionMode": "material-segmentation",
            "materialCandidates": [
                "2_车灯_后转向",
                "2_车灯_刹车灯",
                "2_车灯_后红色",
                "3_玻璃_车灯",
            ],
            "evidence": "Rear-light materials span the liftgate and fixed body halves and must preserve their ownership after segmentation.",
        },
    ))
    return candidates


def build_source_map(candidates):
    components = {}
    for candidate in candidates:
        components[candidate["componentId"]] = {
            key: value
            for key, value in candidate.items()
            if key != "componentId"
        }
    return {
        "contract": "nio-es7-source-map@0.1.0",
        "status": "candidate-pending-blender-confirmation",
        "sourceScene": "source/es7-reference.blend",
        "sourceCollection": SOURCE_COLLECTION,
        "sourceAxisObservation": {
            "lateral": "+X is source-model left",
            "longitudinal": "+Y is source-model rear",
            "vertical": "+Z is up",
            "normalizationTarget": "+X front, +Y left, +Z up",
        },
        "components": components,
    }


def validate_candidates(candidates):
    exclusive_owners = {}
    for candidate in candidates:
        if not candidate["selectionMode"].startswith("whole-object"):
            continue
        for object_name in candidate["sourceObjects"]:
            owner = exclusive_owners.get(object_name)
            if owner:
                fail(f"{object_name} is assigned to both {owner} and {candidate['componentId']}")
            exclusive_owners[object_name] = candidate["componentId"]

    for candidate in candidates:
        material_candidates = candidate.get("materialCandidates")
        if not material_candidates:
            continue
        available = {
            material.name
            for object_name in candidate["sourceObjects"]
            for material in bpy.data.objects[object_name].data.materials
            if material
        }
        missing = sorted(set(material_candidates) - available)
        if missing:
            fail(f"{candidate['componentId']} has missing material candidates: {', '.join(missing)}")

    centers = {
        component_id: world_bounds(bpy.data.objects[source_objects["wheel"]])[0].lerp(
            world_bounds(bpy.data.objects[source_objects["wheel"]])[1], 0.5
        )
        for component_id, source_objects in WHEEL_OBJECTS.items()
    }
    if not (centers["wheel_front_left"].x > 0 and centers["wheel_rear_left"].x > 0):
        fail("left wheels must be on the positive source X side")
    if not (centers["wheel_front_right"].x < 0 and centers["wheel_rear_right"].x < 0):
        fail("right wheels must be on the negative source X side")
    front_y = (centers["wheel_front_left"].y + centers["wheel_front_right"].y) * 0.5
    rear_y = (centers["wheel_rear_left"].y + centers["wheel_rear_right"].y) * 0.5
    if not front_y < rear_y:
        fail("front wheels must be ahead of rear wheels on the source Y axis")


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    if Path(bpy.data.filepath).resolve() != REFERENCE_PATH.resolve():
        fail(f"open {REFERENCE_PATH} before running the audit")

    source_collection = bpy.data.collections.get(SOURCE_COLLECTION)
    if source_collection is None:
        fail(f"missing source collection {SOURCE_COLLECTION}")

    source_objects = sorted(
        (obj for obj in source_collection.all_objects if obj.name != SOURCE_ROOT),
        key=lambda obj: obj.name,
    )
    require_objects(mapped_object_names())

    mesh_objects = [obj for obj in source_objects if obj.type == "MESH"]
    triangle_count = 0
    vertex_count = 0
    for obj in mesh_objects:
        obj.data.calc_loop_triangles()
        vertex_count += len(obj.data.vertices)
        triangle_count += len(obj.data.loop_triangles)

    candidates = build_candidates()
    validate_candidates(candidates)
    audit = {
        "contract": "nio-es7-component-audit@0.1.0",
        "sourceScene": "source/es7-reference.blend",
        "sourceCollection": SOURCE_COLLECTION,
        "summary": {
            "objects": len(source_objects),
            "meshObjects": len(mesh_objects),
            "vertices": vertex_count,
            "triangles": triangle_count,
            "materials": len({material.name for obj in mesh_objects for material in obj.data.materials if material}),
            "images": len(bpy.data.images),
        },
        "candidates": candidates,
        "objects": [serialize_object(obj) for obj in source_objects],
    }

    expected = {"objects": 96, "meshObjects": 47, "triangles": 588958}
    for key, value in expected.items():
        if audit["summary"][key] != value:
            fail(f"{key} changed: expected {value}, got {audit['summary'][key]}")

    write_json(AUDIT_PATH, audit)
    write_json(CANDIDATE_SOURCE_MAP_PATH, build_source_map(candidates))

    print("ES7 COMPONENT AUDIT PASS")
    print(f"- objects: {audit['summary']['objects']}")
    print(f"- mesh objects: {audit['summary']['meshObjects']}")
    print(f"- triangles: {audit['summary']['triangles']}")
    print(f"- candidate components: {len(candidates)}")
    print(f"- audit: {AUDIT_PATH}")
    print(f"- candidate source map: {CANDIDATE_SOURCE_MAP_PATH}")
    print(f"- confirmed source map left unchanged: {CONFIRMED_SOURCE_MAP_PATH}")


if __name__ == "__main__":
    main()
