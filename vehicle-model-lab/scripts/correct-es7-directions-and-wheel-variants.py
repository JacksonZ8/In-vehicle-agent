#!/usr/bin/env python3
"""Correct hood/mirror direction metadata and hide unused source wheel variants."""

import shutil
from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
CHECKPOINT_PATH = LAB_ROOT / "source" / "checkpoints" / "nio-es7-pre-direction-wheel-fix.blend"
STAGE_MARKER = "ES7_DIRECTION_WHEEL_GHOST_FIX"
UNUSED_WHEEL_ROOTS = (
    "es7_work__20_INCH_ELEGANT_DARE ",
    "es7_work__21_INCH_DESIGN_1 ",
    "es7_work__21_INCH_DESIGN_3",
    "es7_work__22_INCH_DESIGN_1",
)


def fail(message):
    raise SystemExit(f"ES7 DIRECTION/WHEEL FIX FAILED: {message}")


def descendants(root):
    result = []
    stack = list(root.children)
    while stack:
        obj = stack.pop()
        result.append(obj)
        stack.extend(obj.children)
    return result


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before applying the fix")
    if bpy.data.objects.get(STAGE_MARKER):
        fail("direction/wheel fix has already been applied")
    if CHECKPOINT_PATH.exists():
        fail(f"checkpoint already exists: {CHECKPOINT_PATH}")
    CHECKPOINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(MASTER_PATH, CHECKPOINT_PATH)

    hood = bpy.data.objects.get("hood_pivot")
    mirror_left = bpy.data.objects.get("mirror_left_fold")
    mirror_right = bpy.data.objects.get("mirror_right_fold")
    if not hood or not mirror_left or not mirror_right:
        fail("hood or mirror pivot is missing")
    hood["open_radians"] = -0.78
    mirror_left["fold_radians"] = 1.05
    mirror_right["fold_radians"] = -1.05

    hidden = []
    for root_name in UNUSED_WHEEL_ROOTS:
        root = bpy.data.objects.get(root_name)
        if not root:
            fail(f"unused wheel root is missing: {root_name}")
        for obj in [root, *descendants(root)]:
            obj["export_forbidden"] = True
            obj["wheel_variant_status"] = "unused-hidden"
            obj.hide_render = True
            obj.hide_viewport = True
            obj.hide_set(True)
            hidden.append(obj.name)

    controlled_wheels = [
        bpy.data.objects.get("wheel_mesh_front_left"),
        bpy.data.objects.get("wheel_mesh_front_right"),
        bpy.data.objects.get("wheel_mesh_rear_left"),
        bpy.data.objects.get("wheel_mesh_rear_right"),
    ]
    if any(obj is None for obj in controlled_wheels):
        fail("a controlled Wheel1 mesh is missing")
    if any(obj.get("export_forbidden") for obj in controlled_wheels):
        fail("a controlled Wheel1 mesh was marked export-forbidden")

    marker = bpy.data.objects.new(STAGE_MARKER, None)
    marker["status"] = "directions-corrected-unused-wheel-variants-hidden"
    marker["hood_open_radians"] = -0.78
    marker["mirror_left_fold_radians"] = 1.05
    marker["mirror_right_fold_radians"] = -1.05
    marker["hidden_object_count"] = len(hidden)
    marker["hidden_objects"] = hidden
    marker["checkpoint"] = str(CHECKPOINT_PATH.relative_to(LAB_ROOT))
    bpy.data.collections["RIG_COMPONENTS"].objects.link(marker)
    bpy.context.scene["es7_motion_direction_fix"] = "hood-negative-y-mirrors-rearward"
    bpy.context.scene["es7_active_wheel_variant"] = "Wheel1"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))

    print("ES7 DIRECTION/WHEEL FIX PASS")
    print("- hood: negative Y")
    print("- mirrors: left positive Z / right negative Z")
    print(f"- unused wheel objects hidden/export-forbidden: {len(hidden)}")
    print("- active wheel variant: Wheel1")
    print(f"- checkpoint: {CHECKPOINT_PATH}")


if __name__ == "__main__":
    main()
