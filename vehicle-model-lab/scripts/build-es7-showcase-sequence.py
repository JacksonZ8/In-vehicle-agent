#!/usr/bin/env python3
"""Build the ES7 Stage-A Blender review sequence without replacing formal clips."""

import json
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
STAGE_MARKER = "ES7_STAGE_A3_SHOWCASE"
SHOWCASE_TRACK = "stage_a_showcase"
SHOWCASE_PREFIX = "es7_showcase__"
LIGHT_PREFIX = "es7_light_review__"
FPS = 30
TIMELINE = {
    "lights": (1, 90),
    "handles": (91, 130),
    "windows": (131, 180),
    "doors": (181, 250),
    "hood": (251, 310),
    "tailgate": (311, 380),
    "steering": (381, 440),
    "wheel_roll": (441, 500),
}


def fail(message):
    raise SystemExit(f"ES7 SHOWCASE BUILD FAILED: {message}")


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def action_fcurves(action):
    for layer in action.layers:
        for strip in layer.strips:
            for channelbag in strip.channelbags:
                yield from channelbag.fcurves


def remove_track(owner, name, managed_stage):
    if not owner.animation_data:
        return
    for track in list(owner.animation_data.nla_tracks):
        if track.name != name:
            continue
        if not all(strip.action and strip.action.get("es7_managed_stage") == managed_stage for strip in track.strips):
            fail(f"refusing to replace unmanaged track {name}")
        owner.animation_data.nla_tracks.remove(track)


def remove_action(name, managed_stage):
    action = bpy.data.actions.get(name)
    if not action:
        return
    if action.get("es7_managed_stage") != managed_stage or action.users:
        fail(f"refusing to replace action {name}")
    bpy.data.actions.remove(action)


def segment_for_action(action_spec):
    action_id = action_spec["id"]
    if "handle" in action_id:
        return TIMELINE["handles"]
    if "window" in action_id:
        return TIMELINE["windows"]
    if "door" in action_id:
        return TIMELINE["doors"]
    if action_id == "hood_open":
        return TIMELINE["hood"]
    if action_id == "tailgate_open":
        return TIMELINE["tailgate"]
    if action_id == "front_wheels_steer":
        return TIMELINE["steering"]
    if action_id == "wheels_roll":
        return TIMELINE["wheel_roll"]
    fail(f"no showcase segment for {action_id}")


def showcase_values(base, action_spec, frame_start, frame_end):
    minimum, maximum = (float(value) for value in action_spec["range"])
    span = frame_end - frame_start
    if minimum < 0.0 < maximum:
        return (
            (frame_start, base),
            (round(frame_start + span * 0.3), base + minimum),
            (round(frame_start + span * 0.7), base + maximum),
            (frame_end, base),
        )
    delta = minimum if abs(minimum) > abs(maximum) else maximum
    if action_spec.get("loop"):
        return ((frame_start, base), (frame_end, base + delta * 2.0))
    midpoint = round((frame_start + frame_end) * 0.5)
    return ((frame_start, base), (midpoint, base + delta), (frame_end, base))


def build_object_showcase(obj, component_id, action_spec):
    action_name = SHOWCASE_PREFIX + component_id
    remove_track(obj, SHOWCASE_TRACK, "A3.2-showcase")
    if obj.animation_data and obj.animation_data.action:
        fail(f"{obj.name} has an unexpected active action")
    remove_action(action_name, "A3.2-showcase")

    data_path = "location" if action_spec["type"] == "translate" else "rotation_euler"
    index = {"X": 0, "Y": 1, "Z": 2}[action_spec["axis"]]
    base = float(getattr(obj, data_path)[index])
    frame_start, frame_end = segment_for_action(action_spec)
    for frame, value in showcase_values(base, action_spec, frame_start, frame_end):
        bpy.context.scene.frame_set(frame)
        getattr(obj, data_path)[index] = value
        obj.keyframe_insert(data_path=data_path, index=index, frame=frame, group=component_id)
    action = obj.animation_data.action
    action.name = action_name
    action["es7_managed_stage"] = "A3.2-showcase"
    action["sequence"] = SHOWCASE_TRACK
    action["component_id"] = component_id
    action["segment_start"] = frame_start
    action["segment_end"] = frame_end
    for curve in action_fcurves(action):
        for keyframe in curve.keyframe_points:
            keyframe.interpolation = "LINEAR" if action_spec.get("loop") else "BEZIER"
            if not action_spec.get("loop"):
                keyframe.easing = "AUTO"
    track = obj.animation_data.nla_tracks.new()
    track.name = SHOWCASE_TRACK
    strip = track.strips.new(action_name, frame_start, action)
    strip.name = SHOWCASE_TRACK
    track.mute = False
    obj.animation_data.action = None
    getattr(obj, data_path)[index] = base


def emission_socket(material):
    node = material.node_tree.nodes.get("Principled BSDF")
    socket = node.inputs.get("Emission Strength") if node else None
    if not socket:
        fail(f"{material.name} has no emission-strength socket")
    return socket


def build_independent_light(control):
    material = bpy.data.materials.get(control["materialSemantic"])
    if not material or not material.node_tree:
        fail(f"missing light material {control['materialSemantic']}")
    owner = material.node_tree
    track_name = control["id"]
    action_name = LIGHT_PREFIX + control["id"]
    remove_track(owner, track_name, "A3.2-light")
    if owner.animation_data and owner.animation_data.action:
        active = owner.animation_data.action
        if active.get("es7_managed_stage") in {"A3.2-light", "A3.2-showcase-light"}:
            owner.animation_data.action = None
        else:
            fail(f"{material.name} has an unmanaged active action")
    remove_action(action_name, "A3.2-light")
    socket = emission_socket(material)
    off_value = float(control["offEmissive"])
    on_value = float(control["onEmissive"])
    if "flashHz" in control:
        half_period = max(1, round(FPS / (float(control["flashHz"]) * 2.0)))
        frames = list(range(1, FPS * 2 + 2, half_period))
        values = [off_value if index % 2 == 0 else on_value for index in range(len(frames))]
    else:
        frames = [1, FPS + 1]
        values = [off_value, on_value]
    for frame, value in zip(frames, values):
        socket.default_value = value
        socket.keyframe_insert(data_path="default_value", frame=frame)
    action = owner.animation_data.action
    action.name = action_name
    action["es7_managed_stage"] = "A3.2-light"
    action["light_control"] = control["id"]
    action["frame_start"] = frames[0]
    action["frame_end"] = frames[-1]
    for curve in action_fcurves(action):
        for keyframe in curve.keyframe_points:
            keyframe.interpolation = "CONSTANT"
    track = owner.animation_data.nla_tracks.new()
    track.name = track_name
    strip = track.strips.new(action_name, frames[0], action)
    strip.name = track_name
    track.mute = True
    owner.animation_data.action = None
    socket.default_value = off_value


def showcase_light_keys(control):
    off_value = float(control["offEmissive"])
    on_value = float(control["onEmissive"])
    control_id = control["id"]
    if control_id == "daytime_running_lights":
        return ((1, off_value), (8, on_value), (82, on_value), (90, off_value))
    if control_id == "low_beams":
        return ((1, off_value), (18, on_value), (68, on_value), (76, off_value), (90, off_value))
    if control_id == "tail_lights":
        return ((1, off_value), (12, on_value), (82, on_value), (90, off_value))
    if control_id == "left_indicator":
        return ((1, off_value), (24, on_value), (34, off_value), (44, on_value), (54, off_value), (90, off_value))
    if control_id == "right_indicator":
        return ((1, off_value), (54, on_value), (64, off_value), (74, on_value), (84, off_value), (90, off_value))
    fail(f"no showcase light timing for {control_id}")


def build_showcase_light(control):
    material = bpy.data.materials[control["materialSemantic"]]
    owner = material.node_tree
    action_name = SHOWCASE_PREFIX + control["id"]
    remove_track(owner, SHOWCASE_TRACK, "A3.2-showcase-light")
    remove_action(action_name, "A3.2-showcase-light")
    socket = emission_socket(material)
    for frame, value in showcase_light_keys(control):
        socket.default_value = value
        socket.keyframe_insert(data_path="default_value", frame=frame)
    action = owner.animation_data.action
    action.name = action_name
    action["es7_managed_stage"] = "A3.2-showcase-light"
    action["sequence"] = SHOWCASE_TRACK
    action["light_control"] = control["id"]
    for curve in action_fcurves(action):
        for keyframe in curve.keyframe_points:
            keyframe.interpolation = "CONSTANT"
    track = owner.animation_data.nla_tracks.new()
    track.name = SHOWCASE_TRACK
    strip = track.strips.new(action_name, TIMELINE["lights"][0], action)
    strip.name = SHOWCASE_TRACK
    track.mute = False
    owner.animation_data.action = None
    socket.default_value = float(control["offEmissive"])


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before building the showcase")
    schema = load_json(SCHEMA_PATH)
    components = {component["id"]: component for component in schema["components"]}

    for action_spec in (action for action in schema["mechanicalActions"] if action.get("stage") is None):
        for target in action_spec["targets"]:
            component_id = target["componentId"]
            obj = bpy.data.objects.get(components[component_id]["nodeName"])
            if not obj:
                fail(f"missing target node for {component_id}")
            build_object_showcase(obj, component_id, action_spec)
    for control in schema["lightControls"]:
        build_independent_light(control)
        build_showcase_light(control)

    marker = bpy.data.objects.get(STAGE_MARKER)
    if not marker:
        marker = bpy.data.objects.new(STAGE_MARKER, None)
        bpy.data.collections["RIG_COMPONENTS"].objects.link(marker)
    marker["stage"] = "A3.2"
    marker["status"] = "stage-a-showcase-built"
    marker["sequence"] = SHOWCASE_TRACK
    marker["frame_start"] = 1
    marker["frame_end"] = 500
    marker["timeline"] = json.dumps(TIMELINE, ensure_ascii=False)

    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start = 1
    scene.frame_end = 500
    scene["es7_rig_stage"] = "A3.2-showcase"
    scene["es7_review_sequence"] = SHOWCASE_TRACK
    scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))
    print("ES7 SHOWCASE BUILD PASS")
    print("- sequence: stage_a_showcase")
    print("- frame range: 1-500 at 30 fps")
    for label, bounds in TIMELINE.items():
        print(f"- {label}: {bounds[0]}-{bounds[1]}")
    print(f"- independent Blender light controls: {len(schema['lightControls'])}")


if __name__ == "__main__":
    main()
