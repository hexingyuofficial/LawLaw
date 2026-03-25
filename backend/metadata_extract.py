from __future__ import annotations

import re
from pathlib import Path

# 文件名或路径片段关键词 -> doc_type
_DOC_TYPE_KEYWORDS: list[tuple[str, str]] = [
    ("微信", "微信记录"),
    ("聊天记录", "微信记录"),
    ("QQ", "即时通讯记录"),
    ("合同", "合同"),
    ("协议", "协议"),
    ("补充协议", "协议"),
    ("起诉状", "起诉状"),
    ("民事起诉", "起诉状"),
    ("答辩状", "答辩状"),
    ("上诉状", "上诉状"),
    ("判决书", "判决书"),
    ("裁定书", "裁定书"),
    ("调解书", "调解书"),
    ("笔录", "笔录"),
    ("询问笔录", "笔录"),
    ("发票", "发票"),
    ("收据", "收据"),
    ("借据", "借据"),
    ("欠条", "欠条"),
    ("邮件", "邮件"),
    ("律师函", "律师函"),
    ("委托书", "委托书"),
    ("授权", "授权文件"),
    ("证据清单", "证据清单"),
    ("质证", "质证意见"),
    ("代理词", "代理词"),
    ("法律意见", "法律意见书"),
]

_DATE_PATTERNS = [
    re.compile(
        r"(?P<y>\d{4})\s*年\s*(?P<m>\d{1,2})\s*月\s*(?P<d>\d{1,2})\s*日"
    ),
    re.compile(r"(?P<y>\d{4})[-/.](?P<m>\d{1,2})[-/.](?P<d>\d{1,2})"),
    re.compile(r"(?P<y>\d{4})(?P<m>\d{2})(?P<d>\d{2})"),
]


def _first_date_match(text: str) -> str | None:
    for pat in _DATE_PATTERNS:
        m = pat.search(text)
        if not m:
            continue
        y, mo, d = int(m.group("y")), int(m.group("m")), int(m.group("d"))
        if 1 <= mo <= 12 and 1 <= d <= 31:
            return f"{y:04d}-{mo:02d}-{d:02d}"
    return None


def infer_doc_type(file_path: Path) -> str:
    name = file_path.name
    stem_lower = file_path.stem.lower()
    combined = f"{name} {stem_lower}"
    for keyword, label in _DOC_TYPE_KEYWORDS:
        if keyword in combined:
            return label
    ext = file_path.suffix.lower()
    if ext in {".md", ".markdown"}:
        return "Markdown 材料"
    if ext in {".txt"}:
        return "文本材料"
    if ext in {".pdf", ".doc", ".docx"}:
        return "卷宗材料"
    if ext in {".xlsx", ".xls", ".csv"}:
        return "表格材料"
    return "其他"


def extract_time_stamp(file_path: Path, text_preview: str) -> str:
    head = (text_preview or "")[:1200]
    for segment in (file_path.name, file_path.stem, head):
        ts = _first_date_match(segment)
        if ts:
            return ts
    return ""


def evidence_chunk_metadata(file_path: Path, text_preview: str) -> dict[str, str]:
    """返回写入 Chroma 的扁平 metadata（仅字符串，空字段可省略）。"""
    source_file = file_path.name
    doc_type = infer_doc_type(file_path)
    time_stamp = extract_time_stamp(file_path, text_preview)
    meta: dict[str, str] = {
        "source_file": source_file,
        "doc_type": doc_type,
    }
    if time_stamp:
        meta["time_stamp"] = time_stamp
    return meta
