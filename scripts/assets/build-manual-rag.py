#!/usr/bin/env python3
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pdfplumber


ROOT = Path(__file__).resolve().parents[2]
SOURCE_FILE = "ES8用户手册.pdf"
PDF_PATH = ROOT / "references" / SOURCE_FILE
OUT_DIR = ROOT / "data" / "manual-rag"

SOURCE_ID = "nio-es8-user-manual-2026"
SOURCE_VERSION = "2026"
TITLE = "蔚来 ES8 用户手册"
CHUNKING_VERSION = "manual-rag-v1-page-heading-window-900-overlap-100"
EMBEDDING_MODEL = "BGE-base-zh-v1.5"
WINDOW_CHARS = 900
OVERLAP_CHARS = 100

CATEGORY_KEYWORDS = [
    ("故障/警告", ["警告", "故障", "报警", "异常", "警示", "救援", "紧急", "应急", "事故", "起火", "泄漏"]),
    ("驾驶辅助", ["辅助驾驶", "领航", "巡航", "泊车", "车道", "盲点", "自动紧急", "驾驶员感知", "环视"]),
    ("补能", ["充电", "换电", "补能", "电池", "续航", "放电", "充电枪", "高压"]),
    ("保养", ["保养", "维护", "清洁", "雨刮片", "洗涤液", "制动液", "冷却液", "轮胎", "滤芯", "洗车"]),
    ("安全限制", ["安全", "安全带", "安全气囊", "儿童", "限速", "隐私", "防护", "撤离"]),
    ("车舱控制", ["座椅", "空调", "车窗", "车门", "尾门", "前舱盖", "后备箱", "灯光", "雨刮", "后视镜", "方向盘", "遮阳帘"]),
    ("智能座舱", ["NOMI", "智慧座舱", "中控屏", "天际屏", "地图", "导航", "影音", "电话", "网络", "应用", "场景", "车内感知"]),
    ("用户操作", ["点击", "长按", "滑动", "设置", "选择", "开启", "关闭", "调节", "解锁", "上锁", "绑定", "账户"]),
]

MAJOR_HEADINGS = {
    "概览",
    "门窗",
    "储物与装载",
    "补能与供电",
    "座椅与空调",
    "方向盘与后视镜",
    "灯光与雨刮",
    "智慧座舱",
    "行车与驻车",
    "车辆与人员安全",
    "行车安全辅助",
    "辅助驾驶",
    "保养与维护",
    "规格与参数",
    "车主应急",
    "紧急救援",
}

NON_SECTION_PREFIXES = (
    "警告",
    "注意",
    "说明",
    "•",
    "●",
    "1.",
    "2.",
    "3.",
    "4.",
    "5.",
    "6.",
    "7.",
    "8.",
    "9.",
)


def clean_text(text):
    text = text or ""
    text = text.replace("\u00a0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def json_default(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return f"sha256:{digest.hexdigest()}"


def is_page_number(line):
    return bool(re.fullmatch(r"\d{1,3}", line.strip()))


def content_lines(text):
    return [line.strip() for line in text.splitlines() if line.strip()]


def looks_like_section_title(line):
    if not line or len(line) > 28:
        return False
    if is_page_number(line):
        return False
    if line.startswith(NON_SECTION_PREFIXES):
        return False
    if re.search(r"[。？！；：,，]$", line):
        return False
    if re.match(r"^\d+\s", line):
        return False
    return bool(re.search(r"[\u4e00-\u9fffA-Za-z]", line))


def infer_sections(pages):
    current_major = "前置说明"
    current_section = "封面与免责声明"
    inferred = {}

    for page in pages:
        lines = content_lines(page["text"])
        if not lines:
            inferred[page["pageNumber"]] = (current_major, current_section)
            continue

        if lines[0] in MAJOR_HEADINGS:
            current_major = lines[0]
            candidate = None
            for line in lines[1:5]:
                if looks_like_section_title(line) and line not in MAJOR_HEADINGS:
                    candidate = line
                    break
            if candidate:
                current_section = candidate
            elif current_section == "封面与免责声明":
                current_section = current_major
        elif page["pageNumber"] <= 6:
            current_major = "前置说明"
            if "目 录" in lines[0] or "目录" in lines[0]:
                current_section = "目录"
            elif page["pageNumber"] == 1:
                current_section = "封面"
            elif page["pageNumber"] == 2:
                current_section = "免责声明"

        inferred[page["pageNumber"]] = (current_major, current_section)

    return inferred


def categorize(text, major, section):
    haystack = f"{major}\n{section}\n{text}"
    scores = []
    for category, keywords in CATEGORY_KEYWORDS:
        score = sum(haystack.count(keyword) for keyword in keywords)
        if score:
            scores.append((score, category))
    if not scores:
        return "其他"
    scores.sort(key=lambda item: (-item[0], item[1]))
    return scores[0][1]


def make_tags(text, major, section, category):
    tags = [major, section, category]
    for keyword in ["车窗", "尾门", "保养", "安全气囊", "充电", "换电", "座椅", "NOMI", "辅助驾驶"]:
        if keyword in text and keyword not in tags:
            tags.append(keyword)
    return tags[:8]


def split_text_with_pages(section_pages):
    combined = ""
    spans = []
    for page in section_pages:
        start = len(combined)
        page_text = page["text"].strip()
        if combined and page_text:
            combined += "\n\n"
        start = len(combined)
        combined += page_text
        spans.append((start, len(combined), page["pageNumber"]))

    if not combined:
        return []

    chunks = []
    start = 0
    while start < len(combined):
        target_end = min(start + WINDOW_CHARS, len(combined))
        if target_end < len(combined):
            breakpoints = [
                combined.rfind(mark, start + 520, target_end)
                for mark in ["\n\n", "。", "；", "！", "？"]
            ]
            end = max(breakpoints)
            if end == -1:
                end = target_end
            else:
                end += 1
        else:
            end = target_end

        chunk_text = combined[start:end].strip()
        if chunk_text:
            touched = [page_no for span_start, span_end, page_no in spans if span_start < end and span_end > start]
            chunks.append((min(touched), max(touched), chunk_text))

        if end >= len(combined):
            break
        start = max(end - OVERLAP_CHARS, start + 1)

    return chunks


def write_jsonl(path, rows):
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, default=json_default, sort_keys=True) + "\n")


def extract_pages():
    pages = []
    with pdfplumber.open(PDF_PATH) as pdf:
        metadata = dict(pdf.metadata or {})
        for index, page in enumerate(pdf.pages, start=1):
            text = clean_text(page.extract_text(x_tolerance=1, y_tolerance=3) or "")
            pages.append(
                {
                    "sourceId": SOURCE_ID,
                    "pageNumber": index,
                    "text": text,
                    "charCount": len(text),
                }
            )
    return pages, metadata


def build_chunks(pages):
    sections = infer_sections(pages)
    groups = []
    for page in pages:
        major, section = sections[page["pageNumber"]]
        section_title = f"{major} / {section}"
        if not groups or groups[-1]["sectionTitle"] != section_title:
            groups.append({"major": major, "section": section, "sectionTitle": section_title, "pages": []})
        groups[-1]["pages"].append(page)

    chunks = []
    chunk_index = 1
    for group in groups:
        for page_start, page_end, text in split_text_with_pages(group["pages"]):
            category = categorize(text, group["major"], group["section"])
            chunk_id = f"es8-manual-chunk-{chunk_index:04d}"
            chunks.append(
                {
                    "chunkId": chunk_id,
                    "sourceId": SOURCE_ID,
                    "title": TITLE,
                    "sectionTitle": group["sectionTitle"],
                    "pageStart": page_start,
                    "pageEnd": page_end,
                    "text": text,
                    "charCount": len(text),
                    "category": category,
                    "tags": make_tags(text, group["major"], group["section"], category),
                    "embeddingStatus": "pending",
                }
            )
            chunk_index += 1
    return chunks


def validate(source, pages, chunks, queue):
    assert source["pageCount"] == 480, f"expected pageCount 480, got {source['pageCount']}"
    assert len(pages) == 480, f"expected 480 page rows, got {len(pages)}"
    assert len(chunks) > 100, f"expected >100 chunks, got {len(chunks)}"
    for chunk in chunks:
        for key in ["pageStart", "pageEnd", "category", "embeddingStatus"]:
            assert key in chunk and chunk[key] not in ("", None), f"missing {key} in {chunk.get('chunkId')}"
        assert chunk["embeddingStatus"] == "pending", f"unexpected embeddingStatus in {chunk['chunkId']}"
    assert len(queue) == len(chunks), "embedding queue row count differs from chunks"

    keyword_hits = {}
    for keyword in ["车窗", "尾门", "保养", "安全气囊"]:
        hits = [chunk["chunkId"] for chunk in chunks if keyword in chunk["text"]]
        assert hits, f"missing chunk containing {keyword}"
        keyword_hits[keyword] = hits[:5]
    return keyword_hits


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pages, metadata = extract_pages()
    chunks = build_chunks(pages)
    queue = [
        {
            "chunkId": chunk["chunkId"],
            "sourceId": chunk["sourceId"],
            "text": chunk["text"],
            "embeddingModel": EMBEDDING_MODEL,
            "status": "pending",
        }
        for chunk in chunks
    ]

    source = {
        "sourceId": SOURCE_ID,
        "sourceVersion": SOURCE_VERSION,
        "contentDigest": sha256_file(PDF_PATH),
        "title": TITLE,
        "sourceFile": SOURCE_FILE,
        "fileSizeBytes": PDF_PATH.stat().st_size,
        "pageCount": len(pages),
        "pdfMetadata": metadata,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "extractionTool": "pdfplumber 0.11.9 via Codex bundled Python",
        "chunkingVersion": CHUNKING_VERSION,
    }

    keyword_hits = validate(source, pages, chunks, queue)

    (OUT_DIR / "es8-manual-source.json").write_text(
        json.dumps(source, ensure_ascii=False, default=json_default, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    write_jsonl(OUT_DIR / "es8-manual-pages.jsonl", pages)
    write_jsonl(OUT_DIR / "es8-manual-chunks.jsonl", chunks)
    write_jsonl(OUT_DIR / "es8-manual-embedding-queue.jsonl", queue)

    readme = f"""# ES8 Manual RAG Data

Generated from `ES8用户手册.pdf` for the P0 manual RAG preparation step.

This is a metadata-only migration: `sourceVersion` and `contentDigest` version the ES8 manual source while chunks and embeddings remain unchanged. `contentDigest` is the SHA-256 of `references/ES8用户手册.pdf`.

- `es8-manual-source.json`: source metadata, PDF metadata, page count, extraction tool, and chunking version.
- `es8-manual-pages.jsonl`: one extracted text row per PDF page.
- `es8-manual-chunks.jsonl`: deterministic text chunks with page spans, section titles, categories, tags, and `embeddingStatus: "pending"`.
- `es8-manual-embedding-queue.jsonl`: pending embedding queue rows for `BGE-base-zh-v1.5`.

Chunking uses stable page heading/title heuristics plus ~{WINDOW_CHARS} Chinese-character windows with ~{OVERLAP_CHARS} characters of overlap. No embeddings have been generated and no runtime integration has been performed.
"""
    (OUT_DIR / "README.md").write_text(readme, encoding="utf-8")

    print(json.dumps({
        "sourcePageCount": source["pageCount"],
        "pageRows": len(pages),
        "chunkRows": len(chunks),
        "queueRows": len(queue),
        "keywordHits": keyword_hits,
    }, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
