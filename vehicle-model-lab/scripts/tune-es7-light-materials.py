#!/usr/bin/env python3
"""Tune ES7 semantic lamp off-state colors while preserving emission controls."""

from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OFF_COLORS = {
    "es7_light_drl": (0.004, 0.007, 0.012, 1.0),
    "es7_light_low_beam": (0.003, 0.006, 0.011, 1.0),
    "es7_light_tail": (0.035, 0.0003, 0.0002, 1.0),
    "es7_light_indicator_left": (0.035, 0.003, 0.0001, 1.0),
    "es7_light_indicator_right": (0.035, 0.003, 0.0001, 1.0),
}


def fail(message):
    raise SystemExit(f"ES7 LIGHT MATERIAL TUNING FAILED: {message}")


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before tuning lights")
    for semantic, color in OFF_COLORS.items():
        material = bpy.data.materials.get(semantic)
        if not material or not material.node_tree:
            fail(f"missing semantic material {semantic}")
        node = material.node_tree.nodes.get("Principled BSDF")
        base_color = node.inputs.get("Base Color") if node else None
        if not base_color:
            fail(f"{semantic} has no Base Color input")
        base_color.default_value = color
        material.diffuse_color = color
        material["off_base_color"] = list(color)
    bpy.context.scene["es7_light_material_tuning"] = "dark-off-state-v1"
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_PATH))
    print("ES7 LIGHT MATERIAL TUNING PASS")
    print(f"- tuned semantic materials: {len(OFF_COLORS)}")


if __name__ == "__main__":
    main()
