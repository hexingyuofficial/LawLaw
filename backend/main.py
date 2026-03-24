from __future__ import annotations

import base64
import json
import logging
import mimetypes
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    import fitz
except Exception:  # pragma: no cover - optional dependency at runtime
    fitz = None

try:
    import pdfplumber
except Exception:  # pragma: no cover - optional dependency at runtime
    pdfplumber = None

try:
    from docx import Document
except Exception:  # pragma: no cover - optional dependency at runtime
    Document = None
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from openai import OpenAI
from sqlmodel import select
from dotenv import load_dotenv

from .chunking import chunk_text
from .metadata_extract import evidence_chunk_metadata
from .db import get_session, init_db
from .models import ChatSessionMessage, Project, ProjectDocument
from .schemas import (
    ChatMessageCreate,
    ChatMessageRead,
    GenerateRequest,
    ModelProbeRequest,
    ProjectCreate,
    ProjectDocumentUpdate,
    ProjectRead,
    ProjectStateRead,
    ProjectUpdate,
    RagQueryRequest,
    RagQueryResponse,
)
from .vector_store import (
    build_metadata_where,
    delete_project_collection,
    embed_texts,
    ensure_project_collection,
    query_project_chunks,
    upsert_project_chunks,
)

load_dotenv(Path(__file__).resolve().parent / ".env")

app_logger = logging.getLogger(__name__)

app = FastAPI(title="LawLaw Backend", version="0.2.8")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ALLOWED_EXTENSIONS = {".zip", ".doc", ".docx", ".pdf", ".png", ".jpg", ".jpeg", ".txt", ".md"}
TEMPLATE_ALLOWED_EXTENSIONS = {".doc", ".docx", ".pdf"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg"}
TEXT_EXTENSIONS = {".txt", ".md", ".doc", ".docx", ".pdf"}
BASE_UPLOAD_DIR = Path(tempfile.gettempdir()) / "lawlaw_uploads"
DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
MAX_TEXT_CHARS_PER_FILE = 8000


def project_dir_by_id(project_id: int) -> Path:
    return BASE_UPLOAD_DIR / str(project_id)


def detect_file_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == ".zip":
        return "ZIP"
    if ext == ".pdf":
        return "PDF"
    if ext in {".doc", ".docx"}:
        return "WORD"
    if ext in IMAGE_EXTENSIONS:
        return "图片"
    return "其他"


def save_upload_file(uploaded: UploadFile, target_path: Path) -> None:
    with target_path.open("wb") as target:
        shutil.copyfileobj(uploaded.file, target)


def list_project_files(project_dir: Path) -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    name_counter: dict[str, int] = {}
    for item in sorted(project_dir.rglob("*")):
        if not item.is_file():
            continue
        if "template" in item.parts:
            continue
        flat_name = item.name
        if flat_name in name_counter:
            name_counter[flat_name] += 1
            stem = Path(flat_name).stem
            suffix = Path(flat_name).suffix
            flat_name = f"{stem}_{name_counter[item.name]}{suffix}"
        else:
            name_counter[flat_name] = 1
        files.append({"name": flat_name, "type": detect_file_type(item)})
    return files


def trim_text(text: str, max_len: int = MAX_TEXT_CHARS_PER_FILE) -> str:
    cleaned = (text or "").strip()
    if len(cleaned) <= max_len:
        return cleaned
    return f"{cleaned[:max_len]}\n...(内容过长，已截断)"


def extract_pdf_text(pdf_path: Path) -> str:
    if pdfplumber is not None:
        try:
            pages: list[str] = []
            with pdfplumber.open(str(pdf_path)) as pdf:
                for page in pdf.pages:
                    pages.append(page.extract_text() or "")
            text = "\n".join(pages).strip()
            if text:
                return text
        except Exception:
            pass

    if fitz is not None:
        try:
            pages = []
            with fitz.open(str(pdf_path)) as doc:
                for page in doc:
                    pages.append(page.get_text("text") or "")
            return "\n".join(pages).strip()
        except Exception:
            return ""
    return ""


def extract_docx_text(docx_path: Path) -> str:
    if Document is None:
        return ""
    try:
        doc = Document(str(docx_path))
        return "\n".join(p.text for p in doc.paragraphs if p.text).strip()
    except Exception:
        return ""


def extract_text_by_file(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == ".pdf":
        return extract_pdf_text(path)
    if ext == ".docx":
        return extract_docx_text(path)
    if ext in {".txt", ".md"}:
        try:
            return path.read_text(encoding="utf-8", errors="ignore").strip()
        except Exception:
            return ""
    return ""


def load_template_text(project_dir: Path) -> str:
    template_dir = project_dir / "template"
    if not template_dir.exists():
        return "（未检测到参考模板）"
    files = [f for f in sorted(template_dir.iterdir()) if f.is_file()]
    if not files:
        return "（未检测到参考模板）"

    template_file = files[0]
    ext = template_file.suffix.lower()
    if ext == ".pdf":
        text = extract_pdf_text(template_file)
    elif ext == ".docx":
        text = extract_docx_text(template_file)
    else:
        text = "（.doc 文件暂不支持直接解析，请转为 .docx / .pdf）"

    text = trim_text(text)
    if not text:
        return f"（模板 {template_file.name} 未提取到可用文本）"
    return text


def encode_image_to_data_url(path: Path) -> str:
    mime_type, _ = mimetypes.guess_type(str(path))
    if not mime_type:
        mime_type = "image/jpeg"
    binary = path.read_bytes()
    encoded = base64.b64encode(binary).decode("utf-8")
    return f"data:{mime_type};base64,{encoded}"


def iter_evidence_files(project_dir: Path) -> Iterable[Path]:
    for item in sorted(project_dir.rglob("*")):
        if not item.is_file():
            continue
        if "template" in item.parts:
            continue
        if item.suffix.lower() == ".zip":
            continue
        yield item


def build_evidence_content_items(project_dir: Path) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    for file_path in iter_evidence_files(project_dir):
        ext = file_path.suffix.lower()
        file_name = file_path.name
        if ext in IMAGE_EXTENSIONS:
            data_url = encode_image_to_data_url(file_path)
            content.append({"type": "text", "text": f"[证据图片 doc:{file_name}]"})
            content.append({"type": "image_url", "image_url": {"url": data_url}})
            continue
        if ext in TEXT_EXTENSIONS:
            text = trim_text(extract_text_by_file(file_path))
            if text:
                content.append({"type": "text", "text": f"[证据文本 doc:{file_name}]\n{text}"})
    if not content:
        content.append({"type": "text", "text": "（未检测到可读取的证据内容）"})
    return content


def sse_event(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def upsert_project_evidence(
    project_id: int,
    embedding_model_id: str | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    project_dir = project_dir_by_id(project_id)
    if not project_dir.exists():
        return {"upserted": 0, "files": 0}

    total_upserted = 0
    processed_files = 0
    for file_path in iter_evidence_files(project_dir):
        text = trim_text(extract_text_by_file(file_path))
        chunks = chunk_text(text)
        if not chunks:
            continue
        preview = text[:800] if text else ""
        chunk_meta = evidence_chunk_metadata(file_path, preview)
        result = upsert_project_chunks(
            project_id=project_id,
            doc_name=file_path.name,
            chunks=chunks,
            embedding_model_id=embedding_model_id,
            chunk_metadata=chunk_meta,
            api_key=api_key,
        )
        total_upserted += int(result["upserted"])
        processed_files += 1
    return {"upserted": total_upserted, "files": processed_files}


def get_project_or_404(project_id: int) -> Project:
    with get_session() as session:
        project = session.get(Project, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="project not found")
        return project


def resolve_chat_vision_id(
    endpoint_id: str | None = None,
    legacy_model_id: str | None = None,
) -> str:
    """请求体 ep- 接入点优先，其次兼容旧字段，最后读 .env。"""
    return (
        (endpoint_id or "").strip()
        or (legacy_model_id or "").strip()
        or (os.getenv("CHAT_VISION_ENDPOINT_ID") or "").strip()
        or (os.getenv("CHAT_VISION_MODEL_ID") or "").strip()
    )


def resolve_embedding_id(
    endpoint_id: str | None = None,
    legacy_model_id: str | None = None,
) -> str:
    return (
        (endpoint_id or "").strip()
        or (legacy_model_id or "").strip()
        or (os.getenv("EMBEDDING_ENDPOINT_ID") or "").strip()
        or (os.getenv("EMBEDDING_MODEL_ID") or "").strip()
    )


def require_chat_vision_id(endpoint_id: str = "", legacy_model_id: str = "") -> str:
    v = resolve_chat_vision_id(endpoint_id or None, legacy_model_id or None)
    if not v:
        raise HTTPException(
            status_code=400,
            detail=(
                "缺少 Chat/Vision 接入点：请在侧栏填写 chat_vision_endpoint_id（ep-…），"
                "或在 backend/.env 配置 CHAT_VISION_ENDPOINT_ID / CHAT_VISION_MODEL_ID。"
            ),
        )
    return v


def require_embedding_id(endpoint_id: str = "", legacy_model_id: str = "") -> str:
    v = resolve_embedding_id(endpoint_id or None, legacy_model_id or None)
    if not v:
        raise HTTPException(
            status_code=400,
            detail=(
                "缺少 Embedding 接入点：请在侧栏填写 embedding_endpoint_id（ep-…），"
                "或在 backend/.env 配置 EMBEDDING_ENDPOINT_ID / EMBEDDING_MODEL_ID。"
            ),
        )
    return v


def resolve_api_key(request_value: str | None = None) -> str:
    return (request_value or "").strip() or (os.getenv("ARK_API_KEY") or "").strip()


def debug_log(run_id: str, hypothesis_id: str, location: str, message: str, data: dict[str, Any]) -> None:
    # #region agent log
    try:
        log_path = Path(__file__).resolve().parent.parent / ".cursor" / "debug-0a12b2.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "sessionId": "0a12b2",
            "runId": run_id,
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data,
            "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
        }
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        pass
    # #endregion


@app.get("/api/config-check")
def config_check() -> dict[str, Any]:
    ark_api_key = (os.getenv("ARK_API_KEY") or "").strip()
    embedding_id = (
        (os.getenv("EMBEDDING_ENDPOINT_ID") or "").strip()
        or (os.getenv("EMBEDDING_MODEL_ID") or "").strip()
    )
    chat_id = (
        (os.getenv("CHAT_VISION_ENDPOINT_ID") or "").strip()
        or (os.getenv("CHAT_VISION_MODEL_ID") or "").strip()
    )

    def mask(value: str) -> str:
        if not value:
            return ""
        if len(value) <= 8:
            return "*" * len(value)
        return f"{value[:4]}***{value[-4:]}"

    return {
        "ok": bool(ark_api_key and embedding_id and chat_id),
        "vars": {
            "ARK_API_KEY": {
                "loaded": bool(ark_api_key),
                "masked": mask(ark_api_key),
            },
            "EMBEDDING_ENDPOINT_ID": {
                "loaded": bool((os.getenv("EMBEDDING_ENDPOINT_ID") or "").strip()),
                "value": (os.getenv("EMBEDDING_ENDPOINT_ID") or "").strip(),
            },
            "EMBEDDING_MODEL_ID": {
                "loaded": bool((os.getenv("EMBEDDING_MODEL_ID") or "").strip()),
                "value": (os.getenv("EMBEDDING_MODEL_ID") or "").strip(),
            },
            "CHAT_VISION_ENDPOINT_ID": {
                "loaded": bool((os.getenv("CHAT_VISION_ENDPOINT_ID") or "").strip()),
                "value": (os.getenv("CHAT_VISION_ENDPOINT_ID") or "").strip(),
            },
            "CHAT_VISION_MODEL_ID": {
                "loaded": bool((os.getenv("CHAT_VISION_MODEL_ID") or "").strip()),
                "value": (os.getenv("CHAT_VISION_MODEL_ID") or "").strip(),
            },
        },
    }


@app.get("/api/model-options")
def model_options() -> dict[str, Any]:
    """兼容旧前端；当前以侧栏手填 ep- 接入点为主，此处仅返回 .env 中的默认值（若有）。"""
    env_chat = resolve_chat_vision_id(None, None)
    env_embed = resolve_embedding_id(None, None)
    return {
        "chat_vision_models": [env_chat] if env_chat else [],
        "embedding_models": [env_embed] if env_embed else [],
        "defaults": {
            "chat_vision_endpoint_id": env_chat,
            "embedding_endpoint_id": env_embed,
            "chat_vision_model_id": env_chat,
            "embedding_model_id": env_embed,
        },
    }


@app.post("/api/model-probe")
def model_probe(payload: ModelProbeRequest) -> dict[str, Any]:
    run_id = f"probe-{int(datetime.now(timezone.utc).timestamp() * 1000)}"
    # #region agent log
    debug_log(
        run_id,
        "H1",
        "backend/main.py:model_probe:start",
        "model_probe request received",
        {
            "has_request_api_key": bool((payload.api_key or "").strip()),
            "request_chat_endpoint": (payload.chat_vision_endpoint_id or "").strip(),
            "request_embedding_endpoint": (payload.embedding_endpoint_id or "").strip(),
            "request_chat_legacy": (payload.chat_vision_model_id or "").strip(),
            "request_embedding_legacy": (payload.embedding_model_id or "").strip(),
        },
    )
    # #endregion
    api_key = resolve_api_key(payload.api_key)
    if not api_key:
        raise HTTPException(status_code=400, detail="缺少 API Key，请在齿轮填写或在 backend/.env 配置 ARK_API_KEY")

    chat_model_id = resolve_chat_vision_id(
        payload.chat_vision_endpoint_id,
        payload.chat_vision_model_id,
    )
    embedding_model_id = resolve_embedding_id(
        payload.embedding_endpoint_id,
        payload.embedding_model_id,
    )
    if not chat_model_id:
        raise HTTPException(
            status_code=400,
            detail="缺少 Chat/Vision 接入点 ID（请求体或 .env 均未配置）。",
        )
    if not embedding_model_id:
        raise HTTPException(
            status_code=400,
            detail="缺少 Embedding 接入点 ID（请求体或 .env 均未配置）。",
        )
    # #region agent log
    debug_log(
        run_id,
        "H2",
        "backend/main.py:model_probe:resolved-config",
        "resolved probe config",
        {
            "api_key_len": len(api_key),
            "api_key_from_request": bool((payload.api_key or "").strip()),
            "chat_model_id": chat_model_id,
            "embedding_model_id": embedding_model_id,
        },
    )
    # #endregion
    client = OpenAI(base_url=DOUBAO_BASE_URL, api_key=api_key)

    embedding_ok = False
    embedding_error = ""
    chat_ok = False
    chat_error = ""

    try:
        embed_texts(
            ["模型连通性测试"],
            embedding_model_id=embedding_model_id,
            api_key=api_key,
        )
        embedding_ok = True
    except Exception as exc:
        embedding_error = str(exc)
        app_logger.warning(
            "model_probe Embedding 探测失败（详情已写入响应 embedding.error）：%s",
            embedding_error[:2000],
        )
        # #region agent log
        debug_log(
            run_id,
            "H3",
            "backend/main.py:model_probe:embedding-error",
            "embedding probe failed",
            {
                "embedding_model_id": embedding_model_id,
                "error": embedding_error[:300],
            },
        )
        # #endregion

    try:
        client.chat.completions.create(
            model=chat_model_id,
            messages=[{"role": "user", "content": "请回复：ok"}],
            max_tokens=8,
            temperature=0,
        )
        chat_ok = True
    except Exception as exc:
        chat_error = str(exc)
        # #region agent log
        debug_log(
            run_id,
            "H4",
            "backend/main.py:model_probe:chat-error",
            "chat probe failed",
            {
                "chat_model_id": chat_model_id,
                "error": chat_error[:300],
            },
        )
        # #endregion

    # #region agent log
    debug_log(
        run_id,
        "H5",
        "backend/main.py:model_probe:result",
        "model_probe finished",
        {
            "ok": embedding_ok and chat_ok,
            "embedding_ok": embedding_ok,
            "chat_ok": chat_ok,
        },
    )
    # #endregion
    return {
        "ok": embedding_ok and chat_ok,
        "embedding": {
            "model_id": embedding_model_id,
            "ok": embedding_ok,
            "error": embedding_error,
        },
        "chat_vision": {
            "model_id": chat_model_id,
            "ok": chat_ok,
            "error": chat_error,
        },
    }


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/projects", response_model=ProjectRead)
def create_project(payload: ProjectCreate) -> Project:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="project name is required")
    with get_session() as session:
        project = Project(name=name)
        session.add(project)
        session.commit()
        session.refresh(project)
        ensure_project_collection(project.id or 0)
        project_dir_by_id(project.id or 0).mkdir(parents=True, exist_ok=True)
        return project


@app.get("/api/projects", response_model=list[ProjectRead])
def list_projects() -> list[Project]:
    with get_session() as session:
        statement = select(Project).order_by(Project.created_at.desc())
        return list(session.exec(statement))


@app.get("/api/projects/{project_id}/state", response_model=ProjectStateRead)
def get_project_state(project_id: int) -> ProjectStateRead:
    get_project_or_404(project_id)
    with get_session() as session:
        doc_statement = select(ProjectDocument).where(ProjectDocument.project_id == project_id)
        project_doc = session.exec(doc_statement).first()
        msg_statement = (
            select(ChatSessionMessage)
            .where(ChatSessionMessage.project_id == project_id)
            .order_by(ChatSessionMessage.created_at.asc(), ChatSessionMessage.id.asc())
        )
        messages = list(session.exec(msg_statement))
    message_payload = [
        ChatMessageRead(
            id=item.id or 0,
            project_id=item.project_id,
            role=item.role,
            content=item.content,
            created_at=item.created_at,
        )
        for item in messages
    ]
    return ProjectStateRead(
        project_id=project_id,
        document=project_doc.content if project_doc else "",
        messages=message_payload,
    )


@app.put("/api/projects/{project_id}/document", response_model=ProjectStateRead)
def save_project_document(project_id: int, payload: ProjectDocumentUpdate) -> ProjectStateRead:
    get_project_or_404(project_id)
    with get_session() as session:
        doc_statement = select(ProjectDocument).where(ProjectDocument.project_id == project_id)
        project_doc = session.exec(doc_statement).first()
        if not project_doc:
            project_doc = ProjectDocument(project_id=project_id, content=payload.content)
        else:
            project_doc.content = payload.content
            project_doc.updated_at = datetime.now(timezone.utc)
        session.add(project_doc)
        session.commit()
    return get_project_state(project_id)


@app.post("/api/projects/{project_id}/messages", response_model=ChatMessageRead)
def append_project_message(project_id: int, payload: ChatMessageCreate) -> ChatMessageRead:
    get_project_or_404(project_id)
    role = payload.role.strip().lower()
    if role not in {"user", "assistant"}:
        raise HTTPException(status_code=400, detail="role must be user or assistant")
    with get_session() as session:
        message = ChatSessionMessage(project_id=project_id, role=role, content=payload.content)
        session.add(message)
        session.commit()
        session.refresh(message)
        return ChatMessageRead(
            id=message.id or 0,
            project_id=message.project_id,
            role=message.role,
            content=message.content,
            created_at=message.created_at,
        )


@app.delete("/api/projects/{project_id}/messages")
def clear_project_messages(project_id: int) -> dict[str, int]:
    get_project_or_404(project_id)
    with get_session() as session:
        statement = select(ChatSessionMessage).where(ChatSessionMessage.project_id == project_id)
        records = list(session.exec(statement))
        deleted = len(records)
        for row in records:
            session.delete(row)
        session.commit()
    return {"project_id": project_id, "deleted": deleted}


@app.patch("/api/projects/{project_id}", response_model=ProjectRead)
def rename_project(project_id: int, payload: ProjectUpdate) -> Project:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="project name is required")
    with get_session() as session:
        project = session.get(Project, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="project not found")
        project.name = name
        session.add(project)
        session.commit()
        session.refresh(project)
        return project


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int) -> dict[str, Any]:
    with get_session() as session:
        project = session.get(Project, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="project not found")

        doc_statement = select(ProjectDocument).where(ProjectDocument.project_id == project_id)
        project_doc = session.exec(doc_statement).first()
        if project_doc:
            session.delete(project_doc)

        msg_statement = select(ChatSessionMessage).where(ChatSessionMessage.project_id == project_id)
        records = list(session.exec(msg_statement))
        for row in records:
            session.delete(row)

        session.delete(project)
        session.commit()

    project_dir = project_dir_by_id(project_id)
    if project_dir.exists():
        shutil.rmtree(project_dir, ignore_errors=True)
    delete_project_collection(project_id)
    return {"project_id": project_id, "status": "deleted"}


@app.post("/api/upload")
async def upload_file(
    project_id: int = Form(...),
    api_key: str | None = Form(default=None),
    embedding_endpoint_id: str | None = Form(default=None),
    embedding_model_id: str | None = Form(default=None),
    file: UploadFile = File(...),
) -> dict[str, object]:
    filename = file.filename or ""
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="unsupported file type")

    project_dir = project_dir_by_id(project_id)
    project_dir.mkdir(parents=True, exist_ok=True)

    safe_name = Path(filename).name
    uploaded_path = project_dir / safe_name
    save_upload_file(file, uploaded_path)

    if suffix == ".zip":
        try:
            with zipfile.ZipFile(uploaded_path, "r") as zip_ref:
                zip_ref.extractall(project_dir)
            uploaded_path.unlink(missing_ok=True)
        except zipfile.BadZipFile as exc:
            uploaded_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="invalid zip file") from exc

    for zip_file in project_dir.rglob("*.zip"):
        zip_file.unlink(missing_ok=True)

    upsert_stats: dict[str, Any] = {"upserted": 0, "files": 0, "skipped": True}
    effective_api_key = resolve_api_key(api_key)
    effective_embedding_model_id = resolve_embedding_id(embedding_endpoint_id, embedding_model_id) or None
    if effective_api_key:
        try:
            ensure_project_collection(project_id)
            stats = upsert_project_evidence(
                project_id=project_id,
                embedding_model_id=effective_embedding_model_id,
                api_key=effective_api_key,
            )
            upsert_stats = {"upserted": stats["upserted"], "files": stats["files"], "skipped": False}
        except Exception as exc:
            upsert_stats = {"upserted": 0, "files": 0, "skipped": False, "error": str(exc)}

    files = list_project_files(project_dir)
    return {
        "project_id": str(project_id),
        "files": files,
        "total": len(files),
        "vector_upsert": upsert_stats,
    }


@app.post("/api/upload-template")
async def upload_template(
    project_id: int = Form(...),
    file: UploadFile = File(...),
) -> dict[str, str]:
    filename = file.filename or ""
    suffix = Path(filename).suffix.lower()
    if suffix not in TEMPLATE_ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="template only supports PDF/Word")

    project_dir = project_dir_by_id(project_id)
    template_dir = project_dir / "template"
    template_dir.mkdir(parents=True, exist_ok=True)

    for old in template_dir.iterdir():
        if old.is_file():
            old.unlink(missing_ok=True)

    safe_name = Path(filename).name
    template_path = template_dir / safe_name
    save_upload_file(file, template_path)
    return {
        "project_id": str(project_id),
        "template_name": safe_name,
        "template_type": detect_file_type(template_path),
        "status": "ok",
    }


@app.post("/api/generate")
async def generate_legal_opinion(payload: GenerateRequest) -> StreamingResponse:
    api_key = resolve_api_key(payload.api_key)
    if not api_key:
        raise HTTPException(status_code=400, detail="缺少 API Key，请在齿轮填写或在 backend/.env 配置 ARK_API_KEY")

    project_dir = project_dir_by_id(payload.project_id)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="project data not found")

    template_text = load_template_text(project_dir)
    evidence_content = build_evidence_content_items(project_dir)
    instruction = payload.instruction.strip() or "请生成法律意见书正文。"
    system_prompt = f"""你是一个资深非诉律师。请根据提供的证据资料，生成法律意见书。

【格式绝对服从】：我为你提供了一份《参考模板》。你必须严格模仿该模板的标题层级、用词习惯、表格样式以及叙述逻辑。

【参考模板内容】：
{template_text}

每次陈述事实，必须在句末用严格格式标注来源：[doc:文件名]。"""

    user_content: list[dict[str, Any]] = [{"type": "text", "text": instruction}, *evidence_content]

    chat_id = require_chat_vision_id(
        payload.chat_vision_endpoint_id,
        payload.chat_vision_model_id,
    )

    def stream_generator() -> Iterable[str]:
        try:
            client = OpenAI(base_url=DOUBAO_BASE_URL, api_key=api_key)
            stream = client.chat.completions.create(
                model=chat_id,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
                stream=True,
                temperature=0.2,
            )
            for chunk in stream:
                delta = ""
                if chunk.choices and chunk.choices[0].delta:
                    delta = chunk.choices[0].delta.content or ""
                if delta:
                    yield sse_event({"type": "delta", "content": delta})
            yield sse_event({"type": "done"})
        except Exception as exc:
            yield sse_event({"type": "error", "message": str(exc)})

    return StreamingResponse(stream_generator(), media_type="text/event-stream")


@app.post("/api/rag-query", response_model=RagQueryResponse)
async def rag_query(payload: RagQueryRequest) -> RagQueryResponse:
    query = payload.query.strip()
    api_key = resolve_api_key(payload.api_key)
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    if not api_key:
        raise HTTPException(status_code=400, detail="缺少 API Key，请在齿轮填写或在 backend/.env 配置 ARK_API_KEY")

    project_dir = project_dir_by_id(payload.project_id)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="project data not found")

    meta_where = build_metadata_where(
        filter_doc_type=payload.filter_doc_type or None,
        filter_source_file=payload.filter_source_file or None,
    )
    embed_id = require_embedding_id(
        payload.embedding_endpoint_id,
        payload.embedding_model_id,
    )
    chat_id = require_chat_vision_id(
        payload.chat_vision_endpoint_id,
        payload.chat_vision_model_id,
    )
    try:
        retrieval = query_project_chunks(
            project_id=payload.project_id,
            query=query,
            top_k=payload.top_k,
            embedding_model_id=embed_id,
            where=meta_where,
            api_key=api_key,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"RAG 检索失败：{exc}") from exc
    docs = retrieval.get("documents", [])
    metas = retrieval.get("metadatas", [])
    if not docs:
        return RagQueryResponse(answer="当前项目还没有可检索内容，请先上传并完成向量入库。", sources=[])

    context_lines: list[str] = []
    source_names: list[str] = []
    for idx, doc in enumerate(docs):
        meta = metas[idx] if idx < len(metas) else {}
        doc_name = str(meta.get("source_file") or meta.get("doc_name", "未知文件"))
        source_names.append(doc_name)
        context_lines.append(f"[doc:{doc_name}] {doc}")
    context = "\n\n".join(context_lines)

    system_prompt = (
        "你是资深非诉律师的项目检索助手。"
        "请仅基于给出的检索片段回答用户问题，不能编造事实。"
        "回答要简洁专业，并在关键句末用 [doc:文件名] 标注来源。"
    )
    user_prompt = f"用户问题：{query}\n\n检索片段：\n{context}"

    try:
        client = OpenAI(base_url=DOUBAO_BASE_URL, api_key=api_key)
        completion = client.chat.completions.create(
            model=chat_id,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
        )
        answer = (completion.choices[0].message.content or "").strip()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"rag query failed: {exc}") from exc

    unique_sources: list[str] = []
    for name in source_names:
        if name not in unique_sources:
            unique_sources.append(name)
    return RagQueryResponse(answer=answer or "未生成有效回答。", sources=unique_sources)


@app.post("/api/rag-query/stream")
async def rag_query_stream(payload: RagQueryRequest) -> StreamingResponse:
    query = payload.query.strip()
    api_key = resolve_api_key(payload.api_key)
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    if not api_key:
        raise HTTPException(status_code=400, detail="缺少 API Key，请在齿轮填写或在 backend/.env 配置 ARK_API_KEY")

    project_dir = project_dir_by_id(payload.project_id)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="project data not found")

    meta_where = build_metadata_where(
        filter_doc_type=payload.filter_doc_type or None,
        filter_source_file=payload.filter_source_file or None,
    )
    try:
        embed_id = require_embedding_id(
            payload.embedding_endpoint_id,
            payload.embedding_model_id,
        )
        chat_id = require_chat_vision_id(
            payload.chat_vision_endpoint_id,
            payload.chat_vision_model_id,
        )
    except HTTPException as exc:
        def config_error_stream() -> Iterable[str]:
            detail = exc.detail
            msg = detail if isinstance(detail, str) else str(detail)
            yield sse_event({"type": "error", "message": msg})
            yield sse_event({"type": "done", "sources": []})

        return StreamingResponse(config_error_stream(), media_type="text/event-stream")

    try:
        retrieval = query_project_chunks(
            project_id=payload.project_id,
            query=query,
            top_k=payload.top_k,
            embedding_model_id=embed_id,
            where=meta_where,
            api_key=api_key,
        )
    except Exception as exc:
        def retrieval_error_stream() -> Iterable[str]:
            yield sse_event({"type": "error", "message": f"RAG 检索失败：{exc}"})
            yield sse_event({"type": "done", "sources": []})

        return StreamingResponse(retrieval_error_stream(), media_type="text/event-stream")
    docs = retrieval.get("documents", [])
    metas = retrieval.get("metadatas", [])
    if not docs:
        def no_context_stream() -> Iterable[str]:
            yield sse_event(
                {
                    "type": "delta",
                    "content": "当前项目还没有可检索内容，请先上传并完成向量入库。",
                }
            )
            yield sse_event({"type": "done", "sources": []})

        return StreamingResponse(no_context_stream(), media_type="text/event-stream")

    context_lines: list[str] = []
    source_names: list[str] = []
    for idx, doc in enumerate(docs):
        meta = metas[idx] if idx < len(metas) else {}
        doc_name = str(meta.get("source_file") or meta.get("doc_name", "未知文件"))
        source_names.append(doc_name)
        context_lines.append(f"[doc:{doc_name}] {doc}")
    context = "\n\n".join(context_lines)

    unique_sources: list[str] = []
    for name in source_names:
        if name not in unique_sources:
            unique_sources.append(name)

    system_prompt = (
        "你是资深非诉律师的项目检索助手。"
        "请仅基于给出的检索片段回答用户问题，不能编造事实。"
        "回答要简洁专业，并在关键句末用 [doc:文件名] 标注来源。"
    )
    user_prompt = f"用户问题：{query}\n\n检索片段：\n{context}"

    def stream_generator() -> Iterable[str]:
        try:
            client = OpenAI(base_url=DOUBAO_BASE_URL, api_key=api_key)
            stream = client.chat.completions.create(
                model=chat_id,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                stream=True,
                temperature=0.2,
            )
            yield sse_event({"type": "sources", "sources": unique_sources})
            for chunk in stream:
                delta = ""
                if chunk.choices and chunk.choices[0].delta:
                    delta = chunk.choices[0].delta.content or ""
                if delta:
                    yield sse_event({"type": "delta", "content": delta})
            yield sse_event({"type": "done", "sources": unique_sources})
        except Exception as exc:
            yield sse_event({"type": "error", "message": str(exc)})

    return StreamingResponse(stream_generator(), media_type="text/event-stream")
