#!/usr/bin/env python3
"""Validate the ES7 Stage-B review sequence."""

import json
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
SCHEMA_PATH = LAB_ROOT / "schema" / "es7-components.json"
SHOWCASE_TRACK = "stage_b_showcase"


def fail(message):
    raise SystemExit(f"ES7 STAGE-B SHOWCASE VALIDATION FAILED: {message}")


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validation")
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    components = {component["id"]: component for component in schema["components"]}
    stage_b_actions = [action for action in schema["mechanicalActions"] if action.get("stage") == "B"]
    tracks_found = 0
    for action_spec in stage_b_actions:
        for target in action_spec["targets"]:
            obj = bpy.data.objects.get(components[target["componentId"]]["nodeName"])
            tracks = [track for track in obj.animation_data.nla_tracks if track.name == SHOWCASE_TRACK]
            if len(tracks) != 1 or tracks[0].mute or len(tracks[0].strips) != 1:
                fail(f"{target['componentId']} Stage-B showcase track is missing or inactive")
            action = tracks[0].strips[0].action
            if action.get("es7_managed_stage") != "B2.2-showcase":
                fail(f"{target['componentId']} Stage-B showcase metadata is incorrect")
            if action.get("segment_start") >= action.get("segment_end"):
                fail(f"{target['componentId']} Stage-B showcase segment is invalid")
            if action.get("target_direction") != int(target["direction"]):
                fail(f"{target['componentId']} Stage-B showcase direction is incorrect")
            tracks_found += 1

    marker = bpy.data.objects.get("ES7_STAGE_B2_SHOWCASE")
    if not marker or marker.get("status") != "stage-b-showcase-built":
        fail("Stage-B showcase marker is missing")
    timeline = json.loads(marker.get("timeline", "{}"))
    if list(timeline) != ["charge-port", "mirrors", "wipers", "suspension"]:
        fail("Stage-B showcase timeline order is incorrect")
    if marker.get("frame_start") != 501 or marker.get("frame_end") != 740:
        fail("Stage-B showcase frame range is incorrect")

    print("ES7 STAGE-B SHOWCASE VALIDATION PASS")
    print(f"- mechanical showcase tracks: {tracks_found}")
    print("- ordered segments: " + ", ".join(timeline))
    print("- frame range: 501-740 at 30 fps")


if __name__ == "__main__":
    main()
