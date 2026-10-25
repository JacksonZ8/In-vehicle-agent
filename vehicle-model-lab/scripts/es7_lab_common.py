#!/usr/bin/env python3
"""Shared constants and helpers for the ES7 Blender lab scripts.

Scripts run as ``blender --python <file>`` insert their own directory into
``sys.path`` before importing this module.
"""

from mathutils import Vector


# Wiper review window on the master timeline, keyed by sweep progress percent.
WIPER_REVIEW_FRAME_START = 601
WIPER_REVIEW_FRAME_END = 670
WIPER_REVIEW_KEYFRAMES = {"0": 601, "25": 618, "50": 636, "75": 653, "100": 670}


def world_bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return minimum, maximum


def objects_world_bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return minimum, maximum
