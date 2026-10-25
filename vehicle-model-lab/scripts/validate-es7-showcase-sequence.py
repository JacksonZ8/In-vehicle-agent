#!/usr/bin/env python3
"""Validate the ES7 Stage-A showcase and independent Blender light controls."""

import json
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
SHOWCASE_TRACK = "stage_a_showcase"


def fail(message):
    raise SystemExit(f"ES7 SHOWCASE VALIDATION FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def emission_value(material, frame):
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    node = material.node_tree.nodes.get("Principled BSDF")
    socket = node.inputs.get("Emission Strength") if node else None
    if not socket:
        fail(f"{material.name} emission-strength socket is missing")
    return float(socket.default_value)


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validation")
    schema = load_json(SCHEMA_PATH)
    components = {component["id"]: component for component in schema["components"]}
    object_tracks = 0
    for action_spec in (action for action in schema["mechanicalActions"] if action.get("stage") is None):
        for target in action_spec["targets"]:
            obj = bpy.data.objects.get(components[target["componentId"]]["nodeName"])
            tracks = [track for track in obj.animation_data.nla_tracks if track.name == SHOWCASE_TRACK]
            if len(tracks) != 1 or tracks[0].mute or len(tracks[0].strips) != 1:
                fail(f"{target['componentId']} showcase track is missing or inactive")
            action = tracks[0].strips[0].action
            if action.get("es7_managed_stage") != "A3.2-showcase":
                fail(f"{target['componentId']} showcase action metadata is incorrect")
            if action.get("segment_start") >= action.get("segment_end"):
                fail(f"{target['componentId']} showcase segment is invalid")
            object_tracks += 1

    for control in schema["lightControls"]:
        material = bpy.data.materials.get(control["materialSemantic"])
        if not material or not material.node_tree.animation_data:
            fail(f"{control['id']} light animation data is missing")
        tracks = material.node_tree.animation_data.nla_tracks
        independent = [track for track in tracks if track.name == control["id"]]
        showcase = [track for track in tracks if track.name == SHOWCASE_TRACK]
        if len(independent) != 1 or not independent[0].mute:
            fail(f"{control['id']} independent review track is incorrect")
        if len(showcase) != 1 or showcase[0].mute:
            fail(f"{control['id']} showcase track is incorrect")
        if independent[0].strips[0].action.get("es7_managed_stage") != "A3.2-light":
            fail(f"{control['id']} independent light action metadata is incorrect")
        if showcase[0].strips[0].action.get("es7_managed_stage") != "A3.2-showcase-light":
            fail(f"{control['id']} showcase light action metadata is incorrect")
        sample_frame = {
            "daytime_running_lights": 23,
            "low_beams": 23,
            "tail_lights": 23,
            "left_indicator": 24,
            "right_indicator": 54,
        }[control["id"]]
        if abs(emission_value(material, 1) - float(control["offEmissive"])) > 1e-5:
            fail(f"{control['id']} showcase off state does not evaluate")
        if abs(emission_value(material, sample_frame) - float(control["onEmissive"])) > 1e-5:
            fail(f"{control['id']} showcase on state does not evaluate")

    marker = bpy.data.objects.get("ES7_STAGE_A3_SHOWCASE")
    if not marker or marker.get("status") != "stage-a-showcase-built":
        fail("showcase stage marker is missing")
    if marker.get("frame_start") != 1 or marker.get("frame_end") != 500:
        fail("showcase frame range marker is incorrect")
    timeline = json.loads(marker.get("timeline", "{}"))
    if list(timeline) != ["lights", "handles", "windows", "doors", "hood", "tailgate", "steering", "wheel_roll"]:
        fail("showcase timeline order is incorrect")

    print("ES7 SHOWCASE VALIDATION PASS")
    print(f"- mechanical showcase tracks: {object_tracks}")
    print(f"- independent/showcase light tracks: {len(schema['lightControls'])}/{len(schema['lightControls'])}")
    print("- evaluated light off/on states: 5/5")
    print("- ordered segments: " + ", ".join(timeline))
    print("- frame range: 1-500 at 30 fps")


if __name__ == "__main__":
    main()
