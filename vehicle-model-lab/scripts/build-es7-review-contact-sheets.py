#!/usr/bin/env python3
"""Build compact contact sheets from ES7 Stage-A review renders."""

import json
from pathlib import Path

from PIL import Image, ImageDraw


LAB_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = LAB_ROOT / "previews" / "es7-actions"
MANIFEST_PATH = OUTPUT_PATH / "review-render-manifest.json"
LABEL_HEIGHT = 30


def fail(message):
    raise SystemExit(f"ES7 CONTACT SHEET FAILED: {message}")


def build_sheet(group, rows):
    images = []
    for row in rows:
        path = OUTPUT_PATH / row["file"]
        if not path.exists():
            fail(f"missing render {path}")
        images.append((row, Image.open(path).convert("RGB")))
    width, height = images[0][1].size
    sheet = Image.new("RGB", (width * len(images), height + LABEL_HEIGHT), (18, 20, 24))
    draw = ImageDraw.Draw(sheet)
    for index, (row, frame) in enumerate(images):
        x = index * width
        sheet.paste(frame, (x, LABEL_HEIGHT))
        draw.text((x + 10, 8), f"{row['progressPercent']}%  frame {row['frame']}", fill=(235, 238, 244))
    path = OUTPUT_PATH / f"contact-{group}.jpg"
    sheet.save(path, quality=90, optimize=True)
    return path.name


def main():
    report = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    groups = {}
    for row in report["renders"]:
        groups.setdefault(row["group"], []).append(row)
    outputs = [build_sheet(group, rows) for group, rows in groups.items()]
    print(f"ES7 CONTACT SHEET PASS: {len(outputs)} sheets")
    for output in outputs:
        print(f"- {output}")


if __name__ == "__main__":
    main()
