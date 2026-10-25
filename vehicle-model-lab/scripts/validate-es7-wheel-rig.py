#!/usr/bin/env python3
"""Validate ES7 wheel steering, rolling, rotor, and caliper hierarchy."""

from pathlib import Path

import bpy


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"


CORNER_CONFIG = {
    "front_left": {"steer": "wheel_front_left_steer", "spin": "wheel_front_left_spin"},
    "front_right": {"steer": "wheel_front_right_steer", "spin": "wheel_front_right_spin"},
    "rear_left": {"steer": None, "spin": "wheel_rear_left_spin"},
    "rear_right": {"steer": None, "spin": "wheel_rear_right_spin"},
}


def fail(message):
    raise SystemExit(f"ES7 WHEEL RIG VALIDATION FAILED: {message}")


def has_ancestor(obj, ancestor):
    parent = obj.parent
    while parent:
        if parent == ancestor:
            return True
        parent = parent.parent
    return False


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before validation")
    vehicle_root = bpy.data.objects.get("vehicle_root")
    if not vehicle_root:
        fail("vehicle_root is missing")

    centers = {}
    for corner, config in CORNER_CONFIG.items():
        steer = bpy.data.objects.get(config["steer"]) if config["steer"] else None
        spin = bpy.data.objects.get(config["spin"])
        wheel = bpy.data.objects.get(f"wheel_mesh_{corner}")
        rotor = bpy.data.objects.get(f"brake_rotor_{corner}")
        caliper = bpy.data.objects.get(f"brake_caliper_{corner}")
        if not spin or not wheel or not rotor or not caliper:
            fail(f"{corner} hierarchy objects are missing")
        if spin.get("spin_axis") != "Y":
            fail(f"{corner} spin axis must be Y")
        if not has_ancestor(wheel, spin) or not has_ancestor(rotor, spin):
            fail(f"{corner} wheel or rotor is not under spin")
        if has_ancestor(caliper, spin):
            fail(f"{corner} caliper must not rotate with spin")
        if steer:
            if steer.parent != vehicle_root or spin.parent != steer:
                fail(f"{corner} steer/spin hierarchy is incorrect")
            if steer.get("steer_axis") != "Z" or not has_ancestor(caliper, steer):
                fail(f"{corner} caliper must steer without spinning")
        else:
            if spin.parent != vehicle_root or caliper.parent != vehicle_root:
                fail(f"{corner} rear wheel hierarchy is incorrect")

        rotor.data.calc_loop_triangles()
        caliper.data.calc_loop_triangles()
        if len(rotor.data.polygons) + len(caliper.data.polygons) != rotor.get("split_source_polygons"):
            fail(f"{corner} brake polygon conservation failed")
        if len(rotor.data.loop_triangles) + len(caliper.data.loop_triangles) != rotor.get("split_source_triangles"):
            fail(f"{corner} brake triangle conservation failed")
        centers[corner] = spin.matrix_world.translation.copy()

    if not (centers["front_left"].x > centers["rear_left"].x):
        fail("front wheels are not ahead of rear wheels")
    if not (centers["front_left"].y > 0 and centers["rear_left"].y > 0):
        fail("left wheels are not on +Y")
    if not (centers["front_right"].y < 0 and centers["rear_right"].y < 0):
        fail("right wheels are not on -Y")
    marker = bpy.data.objects.get("ES7_STAGE_A2_WHEEL_RIG")
    if not marker or marker.get("status") != "steer-spin-and-brake-hierarchy-rigged":
        fail("wheel rig marker is missing")

    print("ES7 WHEEL RIG VALIDATION PASS")
    print("- front steer/spin hierarchies: 2")
    print("- rear spin hierarchies: 2")
    print("- rotating rotors/static calipers: 4/4")


if __name__ == "__main__":
    main()
