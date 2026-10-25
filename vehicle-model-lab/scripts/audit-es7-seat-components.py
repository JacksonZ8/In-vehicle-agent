#!/usr/bin/env python3
"""Audit and render ES7 seat-island candidates without saving the master file."""

import json
from collections import Counter, defaultdict
from pathlib import Path

import bpy
from mathutils import Vector


LAB_ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = LAB_ROOT / "source" / "nio-es7-animation-master.blend"
OUTPUT_PATH = LAB_ROOT / "references" / "es7-cc-by" / "seat-component-audit.json"
PREVIEW_DIR = LAB_ROOT / "previews" / "es7-seat-audit"
BODY_NAME = "es7_work__ES7_Body_C"
INTERIOR_PREFIX = "0_车内_"
VIEWS = {
    "top": ((-0.30, 0.0, 4.4), (-0.30, 0.0, 0.80), 62),
    "left": ((2.15, 3.25, 2.25), (-0.35, 0.10, 0.87), 58),
    "right": ((2.15, -3.25, 2.25), (-0.35, -0.10, 0.87), 58),
    "rear": ((-3.40, 0.0, 1.95), (-0.35, 0.0, 0.88), 62),
}
PALETTES = {
    "front_left": ((0.10, 0.95, 0.95, 1.0), (0.25, 0.55, 1.0, 1.0)),
    "front_right": ((1.0, 0.20, 0.75, 1.0), (0.72, 0.25, 1.0, 1.0)),
    "rear_left": ((0.35, 1.0, 0.25, 1.0), (0.95, 0.88, 0.12, 1.0)),
    "rear_right": ((1.0, 0.42, 0.10, 1.0), (1.0, 0.68, 0.15, 1.0)),
}


def fail(message):
    raise SystemExit(f"ES7 SEAT COMPONENT AUDIT FAILED: {message}")


class DisjointSet:
    def __init__(self, size):
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, value):
        if self.parent[value] != value:
            self.parent[value] = self.find(self.parent[value])
        return self.parent[value]

    def union(self, first, second):
        first_root = self.find(first)
        second_root = self.find(second)
        if first_root == second_root:
            return
        if self.rank[first_root] < self.rank[second_root]:
            first_root, second_root = second_root, first_root
        self.parent[second_root] = first_root
        if self.rank[first_root] == self.rank[second_root]:
            self.rank[first_root] += 1


def rounded(vector):
    return [round(float(value), 6) for value in vector]


def material_name(mesh, polygon):
    if polygon.material_index >= len(mesh.materials) or mesh.materials[polygon.material_index] is None:
        return "<none>"
    return mesh.materials[polygon.material_index].name


def candidate_region(center, size, materials):
    if not any(name.startswith(INTERIOR_PREFIX) for name in materials):
        return None
    if center.z < 0.52 or center.z > 1.55 or max(size) > 1.35:
        return None
    if -0.48 < center.x < 0.64 and 0.14 < center.y < 0.68:
        return "front_left"
    if -0.48 < center.x < 0.64 and -0.68 < center.y < -0.14:
        return "front_right"
    if -1.48 < center.x < -0.62 and 0.02 < center.y < 0.76:
        return "rear_left"
    if -1.48 < center.x < -0.62 and -0.76 < center.y < -0.02:
        return "rear_right"
    return None


def audit_islands(obj):
    mesh = obj.data
    sets = DisjointSet(len(mesh.vertices))
    for edge in mesh.edges:
        sets.union(edge.vertices[0], edge.vertices[1])

    vertices_by_root = defaultdict(list)
    polygons_by_root = defaultdict(list)
    for vertex in mesh.vertices:
        vertices_by_root[sets.find(vertex.index)].append(vertex.index)
    for polygon in mesh.polygons:
        polygons_by_root[sets.find(polygon.vertices[0])].append(polygon.index)

    islands = []
    for root, vertex_indices in vertices_by_root.items():
        polygon_indices = polygons_by_root.get(root, [])
        if not polygon_indices:
            continue
        points = [obj.matrix_world @ mesh.vertices[index].co for index in vertex_indices]
        minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
        maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
        center = (minimum + maximum) * 0.5
        size = maximum - minimum
        materials = Counter(material_name(mesh, mesh.polygons[index]) for index in polygon_indices)
        islands.append({
            "rootVertex": root,
            "vertexIndices": vertex_indices,
            "polygonIndices": polygon_indices,
            "vertices": len(vertex_indices),
            "polygons": len(polygon_indices),
            "triangles": sum(len(mesh.polygons[index].vertices) - 2 for index in polygon_indices),
            "worldBounds": {
                "minimum": rounded(minimum),
                "maximum": rounded(maximum),
                "center": rounded(center),
                "size": rounded(size),
            },
            "materials": [{"name": name, "polygons": count} for name, count in materials.most_common()],
            "candidateRegion": candidate_region(center, size, materials),
            "crossesRearCenter": minimum.y < 0.12 and maximum.y > -0.12 and center.x < -0.62,
        })

    islands.sort(key=lambda item: (-item["polygons"], item["rootVertex"]))
    for index, island in enumerate(islands):
        island["islandId"] = f"{obj.name}:island-{index:03d}"
    return islands


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def create_material(name, color):
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = color
    principled.inputs["Roughness"].default_value = 0.72
    principled.inputs["Metallic"].default_value = 0.0
    return material


def face_object(source, polygon_indices, name, collection, material):
    mesh = source.data
    old_indices = sorted({index for polygon_index in polygon_indices for index in mesh.polygons[polygon_index].vertices})
    index_map = {old_index: new_index for new_index, old_index in enumerate(old_indices)}
    vertices = [mesh.vertices[index].co.copy() for index in old_indices]
    faces = [
        [index_map[index] for index in mesh.polygons[polygon_index].vertices]
        for polygon_index in polygon_indices
    ]
    preview_mesh = bpy.data.meshes.new(f"{name}_mesh")
    preview_mesh.from_pydata(vertices, [], faces)
    preview_mesh.materials.append(material)
    preview_mesh.update()
    preview = bpy.data.objects.new(name, preview_mesh)
    collection.objects.link(preview)
    preview.matrix_world = source.matrix_world.copy()
    return preview


def island_object(source, island, collection, material):
    suffix = island["islandId"].rsplit("-", 1)[-1]
    return face_object(source, island["polygonIndices"], f"seat_audit_{suffix}", collection, material)


def create_label(text, location, collection):
    curve = bpy.data.curves.new(f"seat_label_{text}_curve", "FONT")
    curve.body = text
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = 0.055
    curve.extrude = 0.001
    obj = bpy.data.objects.new(f"seat_label_{text}", curve)
    collection.objects.link(obj)
    obj.location = Vector(location) + Vector((0.0, 0.0, 0.08))
    return obj


def configure_scene(scene):
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 960
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.1
    scene.world.color = (0.012, 0.016, 0.022)


def create_light(name, location, energy, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    point_at(obj, (-0.35, 0.0, 0.85))


def render_candidates(source, candidates):
    for obj in bpy.context.scene.objects:
        obj.hide_render = True
    collection = bpy.data.collections.new("ES7_SEAT_AUDIT_PREVIEW")
    bpy.context.scene.collection.children.link(collection)

    region_counts = defaultdict(int)
    labels = []
    candidate_objects = []
    for island in candidates:
        region = island["candidateRegion"]
        color = PALETTES[region][region_counts[region] % len(PALETTES[region])]
        region_counts[region] += 1
        material = create_material(f"seat_audit_{island['islandId'].rsplit('-', 1)[-1]}_material", color)
        preview = island_object(source, island, collection, material)
        preview.hide_render = False
        candidate_objects.append(preview)
        labels.append(create_label(island["islandId"].rsplit("-", 1)[-1], island["worldBounds"]["center"], collection))

    label_material = create_material("seat_audit_label_material", (1.0, 1.0, 1.0, 1.0))
    for label in labels:
        label.data.materials.append(label_material)
        label.hide_render = False

    scene = bpy.context.scene
    configure_scene(scene)
    camera_data = bpy.data.cameras.new("ES7_SEAT_AUDIT_CAMERA_DATA")
    camera = bpy.data.objects.new("ES7_SEAT_AUDIT_CAMERA", camera_data)
    scene.collection.objects.link(camera)
    camera.hide_render = False
    scene.camera = camera
    create_light("ES7_SEAT_AUDIT_KEY", (1.5, 1.8, 4.0), 1700, 4.0)
    create_light("ES7_SEAT_AUDIT_FILL", (-2.0, -1.8, 2.4), 900, 3.0)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    for view_name, (location, target, lens) in VIEWS.items():
        camera.location = location
        camera.data.lens = lens
        point_at(camera, target)
        for label in labels:
            label.rotation_euler = (camera.location - label.location).to_track_quat("Z", "Y").to_euler()
        scene.render.filepath = str(PREVIEW_DIR / f"seat-candidates-{view_name}.png")
        bpy.ops.render.render(write_still=True)
        print(f"- rendered seat-candidates-{view_name}.png")

    for preview in candidate_objects:
        preview.hide_render = True
    for label in labels:
        label.hide_render = True
    interior_polygons = [
        polygon.index for polygon in source.data.polygons
        if material_name(source.data, polygon).startswith(INTERIOR_PREFIX)
    ]
    clay = create_material("seat_audit_interior_clay", (0.34, 0.43, 0.48, 1.0))
    context = face_object(source, interior_polygons, "seat_audit_interior_context", collection, clay)
    context.hide_render = False
    for view_name, (location, target, lens) in VIEWS.items():
        camera.location = location
        camera.data.lens = lens
        point_at(camera, target)
        scene.render.filepath = str(PREVIEW_DIR / f"interior-context-{view_name}.png")
        bpy.ops.render.render(write_still=True)
        print(f"- rendered interior-context-{view_name}.png")


def main():
    if Path(bpy.data.filepath).resolve() != MASTER_PATH.resolve():
        fail(f"open {MASTER_PATH} before auditing seats")
    source = bpy.data.objects.get(BODY_NAME)
    if source is None or source.type != "MESH":
        fail(f"missing fused interior mesh {BODY_NAME}")
    islands = audit_islands(source)
    candidates = [item for item in islands if item["candidateRegion"] and item["polygons"] >= 20]
    if not candidates:
        fail("no seat-region candidates found")

    report_islands = []
    for island in candidates:
        report_islands.append({key: value for key, value in island.items() if key not in {"vertexIndices", "polygonIndices"}})
    report = {
        "contract": "nio-es7-seat-component-audit@0.1.0",
        "source": "source/nio-es7-animation-master.blend",
        "sourceObject": BODY_NAME,
        "coordinateSystem": {"forward": "+X", "left": "+Y", "up": "+Z"},
        "candidateCount": len(candidates),
        "candidates": report_islands,
        "warnings": [
            "Spatial filtering produces review candidates, not approved seat ownership.",
            "Any rear island crossing the center band must not be assigned to an outer seat without visual review.",
        ],
    }
    OUTPUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    render_candidates(source, candidates)
    print("ES7 SEAT COMPONENT AUDIT PASS")
    print(f"- candidates: {len(candidates)}")
    print(f"- report: {OUTPUT_PATH}")
    print(f"- previews: {PREVIEW_DIR}")


if __name__ == "__main__":
    main()
