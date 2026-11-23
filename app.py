"""书源处理 · Flask 主界面与接口。

路由一览：
    GET  /              返回主界面（templates/index.html）
    POST /api/upload    接收书源 JSON 文件，解析组别并返回 upload_id
    POST /api/sources   根据勾选的组别，返回对应的书源列表
    POST /api/save      按勾选的组别筛出原始书源，作为 JSON 文件下载

上传的文件只在内存中保留（默认 1 小时），不会写入磁盘。
注意：由于状态保存在进程内存中，部署时必须是单 worker（见 gunicorn.conf.py），
多 worker 时请求会落到不同进程，导致上传状态看起来“丢失”。
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from io import BytesIO
from typing import Any

from flask import Flask, jsonify, render_template, request, send_file

app = Flask(__name__)
# 与页面提示保持一致：单个文件最大 32 MB
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024

try:  # Flask 2.3+ 使用 app.json.ensure_ascii
    app.json.ensure_ascii = False
except AttributeError:  # pragma: no cover - 兼容旧版本 Flask
    app.config["JSON_AS_ASCII"] = False


UPLOAD_TTL_SECONDS = 60 * 60  # 上传结果保留 1 小时
MAX_UPLOADS = 20  # 最多同时缓存 20 份上传结果
MAX_SOURCES_PER_RESPONSE = 200  # 单次最多返回的书源条数
UNGROUPED = "未分组"

_uploads: dict[str, dict[str, Any]] = {}
_uploads_lock = threading.Lock()


# ---------------------------------------------------------------------------
# 解析与存储
# ---------------------------------------------------------------------------


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _split_groups(value: Any) -> list[str]:
    """把 "组 A, 组 B" 拆成去重后的列表，兼容中英文逗号。"""
    if not isinstance(value, str):
        return []
    groups: list[str] = []
    for chunk in re.split(r"[,，]", value):
        name = chunk.strip()
        if name and name not in groups:
            groups.append(name)
    return groups


def _unwrap_book_sources(raw: Any) -> list[dict[str, Any]]:
    """取出原始书源条目（保持原顺序，只保留 dict 条目）。"""
    if isinstance(raw, dict):
        for key in ("bookSources", "sources", "data", "items"):
            if isinstance(raw.get(key), list):
                raw = raw[key]
                break
    if not isinstance(raw, list):
        raise ValueError("JSON 根节点应该是书源数组（[...]）。")
    items = [item for item in raw if isinstance(item, dict)]
    if not items:
        raise ValueError("没有从文件里解析到有效的书源条目。")
    return items


def _parse_book_sources(raw: Any) -> list[dict[str, Any]]:
    """提取用于页面展示的字段；原始条目另行保留，供 /api/save 导出。"""
    sources: list[dict[str, Any]] = []
    for item in _unwrap_book_sources(raw):
        name = (
            _clean_text(item.get("bookSourceName") or item.get("name")) or "未命名书源"
        )
        url = _clean_text(item.get("bookSourceUrl") or item.get("url"))
        groups = _split_groups(item.get("bookSourceGroup"))
        if not groups:
            groups = [UNGROUPED]
        sources.append(
            {
                "name": name,
                "url": url,
                "groups": groups,
                "enabled": item.get("enabled", True) is not False,
            }
        )

    return sources


def _summarize_groups(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按书源中出现的顺序汇总组别，'未分组' 固定放在最后。"""
    order: list[str] = []
    counts: dict[str, int] = {}
    for source in sources:
        for group in source["groups"]:
            if group not in counts:
                order.append(group)
                counts[group] = 0
            counts[group] += 1
    order = [group for group in order if group != UNGROUPED]
    if UNGROUPED in counts:
        order.append(UNGROUPED)
    return [{"name": group, "count": counts[group]} for group in order]


def _decode_json_bytes(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("无法识别文件编码，请使用 UTF-8 编码的 JSON 文件。")


def _safe_filename(filename: str) -> str:
    name = os.path.basename((filename or "").replace("\\", "/"))
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    return (name or "bookSources.json")[:120]


def _prune_uploads_locked(now: float) -> None:
    expired = [
        key
        for key, item in _uploads.items()
        if now - item["created_at"] > UPLOAD_TTL_SECONDS
    ]
    for key in expired:
        _uploads.pop(key, None)
    while len(_uploads) >= MAX_UPLOADS:
        oldest = min(_uploads, key=lambda key: _uploads[key]["created_at"])
        _uploads.pop(oldest, None)


def _register_upload(record: dict[str, Any]) -> str:
    upload_id = uuid.uuid4().hex
    now = time.time()
    with _uploads_lock:
        _prune_uploads_locked(now)
        record["created_at"] = now
        _uploads[upload_id] = record
    return upload_id


def _get_upload(upload_id: str) -> dict[str, Any] | None:
    now = time.time()
    with _uploads_lock:
        record = _uploads.get(upload_id)
        if record is None:
            return None
        if now - record["created_at"] > UPLOAD_TTL_SECONDS:
            _uploads.pop(upload_id, None)
            return None
        return record


# ---------------------------------------------------------------------------
# 页面与接口
# ---------------------------------------------------------------------------


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/upload")
def upload():
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "没有收到文件，请重新选择书源 JSON。"}), 400

    data = file.read()
    if not data:
        return jsonify({"error": "文件是空的，请重新选择。"}), 400

    try:
        text = _decode_json_bytes(data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        return jsonify(
            {"error": f"JSON 格式有误：第 {exc.lineno} 行第 {exc.colno} 列附近。"}
        ), 400

    try:
        items = _unwrap_book_sources(raw)
        sources = _parse_book_sources(items)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    groups = _summarize_groups(sources)
    upload_id = _register_upload(
        {
            "filename": _safe_filename(file.filename),
            "size": len(data),
            "sources": sources,
            "groups": groups,
            # 保存原始条目，/api/save 下载时保持阅读书源的完整字段
            "originals": items,
        }
    )

    return jsonify(
        {
            "upload_id": upload_id,
            "filename": _safe_filename(file.filename),
            "size": len(data),
            "source_count": len(sources),
            "groups": groups,
        }
    )


@app.post("/api/sources")
def sources():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "请求体必须是 JSON 对象。"}), 400

    upload_id = payload.get("upload_id")
    if not isinstance(upload_id, str) or not upload_id:
        return jsonify({"error": "缺少 upload_id，请先上传文件。"}), 400

    record = _get_upload(upload_id)
    if record is None:
        return jsonify({"error": "文件已过期或不存在，请重新上传。"}), 404

    selected = payload.get("groups", [])
    if selected is None:
        selected = []
    if not isinstance(selected, list) or not all(
        isinstance(group, str) for group in selected
    ):
        return jsonify({"error": "groups 必须是字符串数组。"}), 400

    wanted = set(selected)
    if wanted:
        matched = [
            source
            for source in record["sources"]
            if wanted.intersection(source["groups"])
        ]
    else:
        matched = []

    total = len(matched)
    limited = matched[:MAX_SOURCES_PER_RESPONSE]
    return jsonify(
        {
            "total": total,
            "returned": len(limited),
            "truncated": total > len(limited),
            "limit": MAX_SOURCES_PER_RESPONSE,
            "sources": [
                {
                    "name": source["name"],
                    "url": source["url"],
                    "groups": source["groups"],
                    "enabled": source["enabled"],
                }
                for source in limited
            ],
        }
    )


@app.post("/api/save")
def save():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "请求体必须是 JSON 对象。"}), 400

    upload_id = payload.get("upload_id")
    if not isinstance(upload_id, str) or not upload_id:
        return jsonify({"error": "缺少 upload_id，请先上传文件。"}), 400

    record = _get_upload(upload_id)
    if record is None:
        return jsonify({"error": "文件已过期或不存在，请重新上传。"}), 404

    selected = payload.get("groups", [])
    if selected is None:
        selected = []
    if not isinstance(selected, list) or not all(
        isinstance(group, str) for group in selected
    ):
        return jsonify({"error": "groups 必须是字符串数组。"}), 400

    wanted = set(selected)
    if not wanted:
        return jsonify({"error": "请至少勾选一个书源组别后再保存。"}), 400

    # 用展示用的 groups 做匹配，导出时写回原始条目（保留全部字段）
    originals = record.get("originals")
    if not originals:
        return jsonify({"error": "上传结果缺少原始书源数据，请重新上传。"}), 409

    matched = [
        original
        for original, source in zip(originals, record["sources"])
        if wanted.intersection(source["groups"])
    ]

    stem = os.path.splitext(record["filename"])[0].strip() or "bookSources"
    save_filename = stem[:80] + "_filtered.json"

    response = send_file(
        BytesIO(json.dumps(matched, ensure_ascii=False, indent=2).encode("utf-8")),
        mimetype="application/json",
        as_attachment=True,
        download_name=save_filename,
    )
    response.headers["X-Source-Count"] = str(len(matched))
    response.headers["Cache-Control"] = "no-store"
    return response


@app.errorhandler(413)
def payload_too_large(_error):
    return jsonify({"error": "文件超过 32 MB 限制，请精简后再上传。"}), 413


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
