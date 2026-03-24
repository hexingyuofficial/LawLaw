from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class ProjectUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class ProjectRead(BaseModel):
    id: int
    name: str
    created_at: datetime


class ProjectDocumentUpdate(BaseModel):
    content: str = ""


class ChatMessageCreate(BaseModel):
    role: str = Field(min_length=1, max_length=20)
    content: str = ""


class ChatMessageRead(BaseModel):
    id: int
    project_id: int
    role: str
    content: str
    created_at: datetime


class ProjectStateRead(BaseModel):
    project_id: int
    document: str
    messages: list[ChatMessageRead]


class GenerateRequest(BaseModel):
    project_id: int
    api_key: str = ""
    chat_vision_endpoint_id: str = ""
    embedding_endpoint_id: str = ""
    chat_vision_model_id: str = ""
    embedding_model_id: str = ""
    instruction: str = ""


class RagQueryRequest(BaseModel):
    project_id: int
    api_key: str = ""
    chat_vision_endpoint_id: str = ""
    embedding_endpoint_id: str = ""
    chat_vision_model_id: str = ""
    embedding_model_id: str = ""
    query: str
    top_k: int = 6
    # 可选：按入库时的 metadata 过滤（Chroma where）
    filter_doc_type: str = ""
    filter_source_file: str = ""


class RagQueryResponse(BaseModel):
    answer: str
    sources: list[str]


class ModelProbeRequest(BaseModel):
    api_key: str = ""
    chat_vision_endpoint_id: str = ""
    embedding_endpoint_id: str = ""
    chat_vision_model_id: str = ""
    embedding_model_id: str = ""
