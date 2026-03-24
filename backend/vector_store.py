from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import chromadb
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

CHROMA_DIR = Path(__file__).resolve().parent / "chroma_data"
EMBEDDING_BASE_URL = (os.getenv("EMBEDDING_BASE_URL") or "https://ark.cn-beijing.volces.com/api/v3").rstrip("/")
# 标准文本 Embedding（OpenAI 兼容）：input 为 string 或 string[]
EMBEDDINGS_URL = f"{EMBEDDING_BASE_URL}/embeddings"
# 多模态向量（如 doubao-embedding-vision / 对应 ep- 接入点）：input 为 [{type, text}, ...]
EMBEDDINGS_MULTIMODAL_URL = f"{EMBEDDING_BASE_URL}/embeddings/multimodal"

chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))

logger = logging.getLogger(__name__)


def _json_preview(obj: Any, max_len: int = 2400) -> str:
    try:
        s = json.dumps(obj, ensure_ascii=False, default=str)
    except Exception:
        s = str(obj)
    if len(s) > max_len:
        return f"{s[:max_len]}…(共 {len(s)} 字符，已截断)"
    return s


def _is_vector_list(x: Any) -> bool:
    return isinstance(x, list) and len(x) > 0 and all(isinstance(v, (int, float)) for v in x)


def _extract_embedding_vectors(body: dict[str, Any], _depth: int = 0) -> list[list[float]] | None:
    """从方舟 / OpenAI 等多种可能的响应体中提取向量列表（每条文本一行向量）。"""
    if _depth > 6:
        return None

    # 显式错误对象
    err = body.get("error")
    if isinstance(err, dict) and (err.get("message") or err.get("code")):
        return None

    # OpenAI：data 为数组
    data = body.get("data")
    if isinstance(data, list) and data:
        vectors: list[list[float]] = []
        for item in data:
            if isinstance(item, dict):
                emb = item.get("embedding") or item.get("vector")
                if _is_vector_list(emb):
                    vectors.append([float(x) for x in emb])
                else:
                    return None
            elif _is_vector_list(item):
                vectors.append([float(x) for x in item])
            else:
                return None
        if len(vectors) == len(data):
            return vectors

    # data 为单对象（部分网关封装）
    if isinstance(data, dict):
        nested = _extract_embedding_vectors(data, _depth + 1)
        if nested:
            return nested

    # 顶层单条向量
    for key in ("embedding", "vector"):
        val = body.get(key)
        if _is_vector_list(val):
            return [[float(x) for x in val]]

    # 批量：embeddings / vectors
    embs = body.get("embeddings")
    if isinstance(embs, list) and embs and all(_is_vector_list(v) for v in embs):
        return [[float(x) for x in v] for v in embs]
    vecs = body.get("vectors")
    if isinstance(vecs, list) and vecs and all(_is_vector_list(v) for v in vecs):
        return [[float(x) for x in v] for v in vecs]

    # 常见嵌套：result / output / Response
    for key in ("result", "output", "Response", "response"):
        inner = body.get(key)
        if isinstance(inner, dict):
            nested = _extract_embedding_vectors(inner, _depth + 1)
            if nested:
                return nested

    return None


def collection_name(project_id: int) -> str:
    return f"project_{project_id}"


def ensure_project_collection(project_id: int):
    return chroma_client.get_or_create_collection(name=collection_name(project_id))


def delete_project_collection(project_id: int) -> None:
    try:
        chroma_client.delete_collection(name=collection_name(project_id))
    except Exception:
        pass


def get_ark_api_key() -> str:
    api_key = (os.getenv("ARK_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("缺少 ARK_API_KEY，请在 backend/.env 中配置。")
    return api_key


def resolve_ark_api_key_for_embedding(request_api_key: str | None) -> str:
    """请求体中的 Key 优先，否则读环境变量 ARK_API_KEY。"""
    k = (request_api_key or "").strip()
    if k:
        return k
    return get_ark_api_key()


def get_embedding_model_id() -> str:
    """方舟接入点 ID：优先 EMBEDDING_ENDPOINT_ID，兼容旧变量 EMBEDDING_MODEL_ID。"""
    for key in ("EMBEDDING_ENDPOINT_ID", "EMBEDDING_MODEL_ID"):
        model_id = (os.getenv(key) or "").strip()
        if model_id:
            return model_id
    raise RuntimeError(
        "缺少 EMBEDDING_ENDPOINT_ID（或兼容项 EMBEDDING_MODEL_ID），请在 backend/.env 中配置。"
    )


def _parse_embedding_response(body: Any) -> list[list[float]]:
    if not isinstance(body, dict):
        preview = _json_preview(body)
        logger.error("Embedding 解析失败：顶层非对象。原始：%s", preview)
        raise RuntimeError(f"Embedding 返回非 JSON 对象或格式异常。原始：{preview}")

    err = body.get("error")
    if isinstance(err, dict) and (err.get("message") or err.get("code")):
        msg = err.get("message") or err.get("code") or str(err)
        preview = _json_preview(body)
        logger.error("Embedding API 返回 error 字段。原始：%s", preview)
        raise RuntimeError(f"Embedding API 错误：{msg}。完整响应：{preview}")

    extracted = _extract_embedding_vectors(body)
    if extracted is None:
        preview = _json_preview(body)
        logger.error("Embedding 无法从响应中解析向量。原始 JSON：%s", preview)
        raise RuntimeError(
            "Embedding 返回结构无法解析（未找到 data[].embedding / 顶层 embedding / embeddings 等）。"
            f"请对照方舟文档核对字段。原始 JSON：{preview}"
        )
    return extracted


def _embedding_uses_multimodal_api(model_id: str) -> bool:
    """方舟接入点 ID（ep-）当前多用于多模态向量模型；展示名含 embedding-vision 的也必须走 multimodal 路径。"""
    m = model_id.strip()
    if m.startswith("ep-"):
        return True
    return "embedding-vision" in m.lower()


def _embed_one_text(api_key: str, model_id: str, text: str) -> list[float]:
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    mid = model_id.strip()
    if _embedding_uses_multimodal_api(mid):
        url = EMBEDDINGS_MULTIMODAL_URL
        payload: dict[str, Any] = {
            "model": mid,
            "input": [{"type": "text", "text": text}],
        }
    else:
        url = EMBEDDINGS_URL
        payload = {"model": mid, "input": text}
    resp = requests.post(url, headers=headers, json=payload, timeout=120)
    try:
        body = resp.json()
    except Exception as exc:
        raise RuntimeError(f"Embedding 响应非 JSON：HTTP {resp.status_code}") from exc
    if resp.status_code >= 400:
        msg = ""
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                msg = str(err.get("message") or err.get("code") or err)
            elif err is not None:
                msg = str(err)
        if not msg:
            msg = resp.text[:500] if resp.text else str(resp.status_code)
        raw = _json_preview(body) if isinstance(body, dict) else (resp.text[:800] if resp.text else "")
        raise RuntimeError(f"Embedding HTTP {resp.status_code}：{msg}。响应体：{raw}")
    try:
        vecs = _parse_embedding_response(body)
    except RuntimeError:
        raise
    except Exception as exc:
        preview = _json_preview(body)
        logger.exception("Embedding 解析异常，原始：%s", preview)
        raise RuntimeError(f"Embedding 解析异常：{exc}。原始 JSON：{preview}") from exc
    if len(vecs) != 1:
        preview = _json_preview(body)
        logger.error("Embedding 期望 1 条向量，实际 %s 条。原始：%s", len(vecs), preview)
        raise RuntimeError(
            f"Embedding 单次请求应返回 1 条向量，实际 {len(vecs)} 条。原始 JSON：{preview}"
        )
    return vecs[0]


def embed_texts(
    texts: list[str],
    embedding_model_id: str | None = None,
    api_key: str | None = None,
) -> list[list[float]]:
    if not texts:
        return []
    resolved_key = resolve_ark_api_key_for_embedding(api_key)
    model_id = (embedding_model_id or "").strip() or get_embedding_model_id()
    vectors: list[list[float]] = []
    try:
        for text in texts:
            vectors.append(_embed_one_text(resolved_key, model_id, text))
    except RuntimeError:
        raise
    except Exception as exc:
        message = str(exc)
        lowered = message.lower()
        if "invalidendpointormodel" in lowered or "not found" in lowered or "does not exist" in lowered:
            raise RuntimeError(
                "当前 Embedding 接入点不可用或无权限。请设置 EMBEDDING_ENDPOINT_ID 为控制台中的 ep- 接入点 ID。"
            ) from exc
        if "api key" in lowered or "unauthorized" in lowered or "401" in lowered:
            raise RuntimeError("Embedding 鉴权失败，请检查 ARK_API_KEY。") from exc
        raise RuntimeError(f"Embedding 调用失败：{message}") from exc
    return vectors


def _merge_chunk_metadata(
    project_id: int,
    doc_name: str,
    chunk_index: int,
    extra: dict[str, str] | None,
) -> dict[str, Any]:
    meta: dict[str, Any] = {
        "project_id": str(project_id),
        "doc_name": doc_name,
        "chunk_index": chunk_index,
    }
    if not extra:
        return meta
    for key, value in extra.items():
        if value is None:
            continue
        s = str(value).strip()
        if s:
            meta[key] = s
    return meta


def upsert_project_chunks(
    project_id: int,
    doc_name: str,
    chunks: list[str],
    embedding_model_id: str | None = None,
    chunk_metadata: dict[str, str] | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    if not chunks:
        return {"upserted": 0, "doc_name": doc_name}

    vectors = embed_texts(
        texts=chunks,
        embedding_model_id=embedding_model_id,
        api_key=api_key,
    )
    collection = ensure_project_collection(project_id)
    ids = [f"{doc_name}::chunk::{idx}" for idx in range(len(chunks))]
    metadatas = [
        _merge_chunk_metadata(project_id, doc_name, idx, chunk_metadata)
        for idx in range(len(chunks))
    ]
    collection.upsert(ids=ids, documents=chunks, embeddings=vectors, metadatas=metadatas)
    return {"upserted": len(chunks), "doc_name": doc_name}


def build_metadata_where(
    filter_doc_type: str | None = None,
    filter_source_file: str | None = None,
) -> dict[str, Any] | None:
    """构造 Chroma where，供检索过滤（与 upsert 写入的 metadata 键一致）。"""
    clauses: list[dict[str, Any]] = []
    dt = (filter_doc_type or "").strip()
    sf = (filter_source_file or "").strip()
    if dt:
        clauses.append({"doc_type": dt})
    if sf:
        clauses.append({"source_file": sf})
    if not clauses:
        return None
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}


def query_project_chunks(
    project_id: int,
    query: str,
    top_k: int = 6,
    embedding_model_id: str | None = None,
    where: dict[str, Any] | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    query_text = (query or "").strip()
    if not query_text:
        return {"documents": [], "metadatas": []}

    collection = ensure_project_collection(project_id)
    query_vec = embed_texts(
        texts=[query_text],
        embedding_model_id=embedding_model_id,
        api_key=api_key,
    )
    if not query_vec:
        return {"documents": [], "metadatas": []}

    kwargs: dict[str, Any] = {
        "query_embeddings": query_vec,
        "n_results": max(top_k, 1),
    }
    if where:
        kwargs["where"] = where

    result = collection.query(**kwargs)
    documents = result.get("documents", [[]])[0] if result.get("documents") else []
    metadatas = result.get("metadatas", [[]])[0] if result.get("metadatas") else []
    return {"documents": documents, "metadatas": metadatas}
