#!/usr/bin/env python3
"""Apply the approved ES7 tailgate and wiper direction metadata correction."""

import shutil
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-tailgate-wiper-direction-fix.blend"
MARKER_NAME = "ES7_TAILGATE_WIPER_DIRECTION_FIX"


def fail(message):
    raise SystemExit(f"ES7 TAILGATE/WIPER DIRECTION FIX FAILED: {message}")


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before applying the fix")
    if bpy.data.objects.get(MARKER_NAME):
        fail("tailgate/wiper direction fix has already been applied")
    if CHECKPOINT_PATH.exists():
        fail(f"checkpoint already exists: {CHECKPOINT_PATH}")
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)

    tailgate = bpy.data.objects.get("tailgate_pivot")
    wipers = [bpy.data.objects.get("wiper_left_pivot"), bpy.data.objects.get("wiper_right_pivot")]
    if not tailgate or any(wiper is None for wiper in wipers):
        fail("tailgate or wiper pivot is missing")
    scene = bpy.context.scene
    scene.frame_set(1)
    bpy.context.view_layer.update()
    tailgate.rotation_euler.y = 0.0
    tailgate["open_radians"] = 1.08
    tailgate["open_direction"] = 1
    for wiper in wipers:
        wiper.rotation_euler.z = 0.0
        wiper["sweep_radians"] = -1.08
        wiper["sweep_direction"] = -1

    marker = bpy.data.objects.new(MARKER_NAME, None)
    marker["status"] = "tailgate-positive-y-wipers-negative-z"
    marker["tailgate_open_radians"] = 1.08
    marker["wiper_sweep_radians"] = -1.08
    marker["checkpoint"] = str(CHECKPOINT_PATH.relative_to(LAB_ROOT))
    bpy.data.collections["RIG_COMPONENTS"].objects.link(marker)
    scene["es7_tailgate_wiper_direction_fix"] = "tailgate-positive-y-wipers-negative-z"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))

    print("ES7 TAILGATE/WIPER DIRECTION FIX PASS")
    print("- tailgate: positive Y")
    print("- left/right wipers: negative local Z")
    print(f"- checkpoint: {CHECKPOINT_PATH}")


if __name__ == "__main__":
    main()
