#!/usr/bin/env python3
"""SUPERSEDED: formerly applied opposite local signs for a dual-wiper upward sweep.

The current contract (schema/es7-components.json, verify/verify-es7-schema.mjs) requires
both wipers to sweep along negative local Z, as applied by
correct-es7-tailgate-wiper-directions.py. This script refuses to run so that a re-run
cannot write the obsolete right-wiper +1 direction into the master.
"""

import filecmp
import shutil
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-dual-wiper-upward-fix.blend"
MARKER_NAME = "ES7_DUAL_WIPER_UPWARD_FIX"
SUPERSEDED_MESSAGE = (
    "this script is superseded and disabled: it sets the right wiper to +1 local Z, but "
    "schema/es7-components.json (wipers_sweep) and verify/verify-es7-schema.mjs require both "
    "wipers at -1; use scripts/correct-es7-tailgate-wiper-directions.py instead"
)


def fail(message):
    raise SystemExit(f"ES7 DUAL-WIPER UPWARD FIX FAILED: {message}")


def main():
    fail(SUPERSEDED_MESSAGE)
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before applying the fix")
    if bpy.data.objects.get(MARKER_NAME):
        fail("dual-wiper upward fix has already been applied")
    if CHECKPOINT_PATH.exists() and not filecmp.cmp(MASTER_PATH, CHECKPOINT_PATH, shallow=False):
        fail(f"existing checkpoint differs from the current pre-fix master: {CHECKPOINT_PATH}")

    left = bpy.data.objects.get("wiper_left_pivot")
    right = bpy.data.objects.get("wiper_right_pivot")
    if left is None or right is None:
        fail("left or right wiper pivot is missing")
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not CHECKPOINT_PATH.exists():
        shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)

    scene = bpy.context.scene
    scene.frame_set(1)
    bpy.context.view_layer.update()
    left.rotation_euler.z = 0.0
    left["sweep_radians"] = -1.08
    left["sweep_direction"] = -1
    right.rotation_euler.z = 0.0
    right["sweep_radians"] = 1.08
    right["sweep_direction"] = 1

    marker = bpy.data.objects.new(MARKER_NAME, None)
    marker["status"] = "left-negative-z-right-positive-z"
    marker["left_sweep_radians"] = -1.08
    marker["right_sweep_radians"] = 1.08
    marker["duration_seconds"] = 0.9
    marker["checkpoint"] = str(CHECKPOINT_PATH.relative_to(LAB_ROOT))
    bpy.data.collections["RIG_COMPONENTS"].objects.link(marker)
    scene["es7_dual_wiper_upward_fix"] = "left-negative-z-right-positive-z"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))

    print("ES7 DUAL-WIPER UPWARD FIX PASS")
    print("- left wiper: negative local Z")
    print("- right wiper: positive local Z")
    print(f"- checkpoint: {CHECKPOINT_PATH}")


if __name__ == "__main__":
    main()
