# LawLaw — 技术上下文（给 AI / 接手开发的说明）

面向需要改代码、排错或扩展功能的读者。人类向介绍见根目录 [`README.md`](README.md)。

## 1. 项目定位

- **LawLaw**：非诉律师工作流向的本地 Web 工作台。
- **前端**：Next.js（`app/`、`components/`），默认开发端口 **3000**。
- **后端**：FastAPI（`backend/main.py`），典型开发端口 **8000**。
- **外部依赖**：火山方舟 `https://ark.cn-beijing.volces.com/api/v3`（Chat 兼容 OpenAI SDK；Embedding 使用 `requests` 直连 HTTP）。

## 2. 顶层目录（与职责）

| 路径 | 说明 |
|------|------|
| `app/` | Next App Router：`page.tsx`、`layout.tsx` |
| `components/workspace/` | 侧栏项目列表与 API 设置、证据池、BlockNote 编辑器、RAG 聊天 |
| `lib/ark-settings.ts` | 浏览器 localStorage 键与方舟三件套读取；含旧键迁移 |
| `backend/main.py` | FastAPI 应用、路由、业务编排 |
| `backend/db.py` | SQLModel + SQLite：`backend/lawlaw.db` |
| `backend/models.py` | `Project`、`ProjectDocument`（每项目一条文档）、`ChatSessionMessage` |
| `backend/schemas.py` | Pydantic 请求/响应模型 |
| `backend/vector_store.py` | Chroma 持久化、方舟 Embedding HTTP、检索 `where` 构造 |
| `backend/chunking.py` | 文本切块 |
| `backend/metadata_extract.py` | 证据文件 `doc_type` / `time_stamp` / `source_file` 轻量推断 |
| `backend/chroma_data/` | Chroma 持久化目录（按 collection 隔离项目） |
| `backend/.env` | 本地密钥与默认接入点（勿提交真实密钥） |
| `backend/.env.example` | 环境变量模板 |

## 3. 运行时数据落点

- **SQLite**：`backend/lawlaw.db`（`DATABASE_URL` 在 `backend/db.py`）。
- **上传证据 / 解压 zip**：系统临时目录下 `lawlaw_uploads/<project_id>/`（`BASE_UPLOAD_DIR`，见 `main.py`）。
- **Chroma**：`backend/chroma_data/`，collection 名 `project_{project_id}`（`vector_store.collection_name`）。
- **模板**：每项目 `project_dir/template/`，生成意见书时读取其中**第一个**模板文件（PDF/Word）。

## 4. 凭证与模型 ID 解析（后端）

统一原则：**请求体优先，其次 `backend/.env`**。

| 能力 | 解析函数 | 顺序 |
|------|----------|------|
| API Key | `resolve_api_key(request)` | `payload.api_key` → `ARK_API_KEY` |
| Chat / Vision 模型 | `resolve_chat_vision_id(ep, legacy)` | `chat_vision_endpoint_id` → `chat_vision_model_id` → `CHAT_VISION_ENDPOINT_ID` → `CHAT_VISION_MODEL_ID` |
| Embedding 接入点 | `resolve_embedding_id(ep, legacy)` | `embedding_endpoint_id` → `embedding_model_id` → `EMBEDDING_ENDPOINT_ID` → `EMBEDDING_MODEL_ID` |

- RAG、流式生成、探测等路径在需要时会调用 `require_*`，解析为空返回 **HTTP 400**。
- **Embedding 调用方舟时必须带 Key**：`vector_store.resolve_ark_api_key_for_embedding(request_api_key)`，与 `embed_texts(..., api_key=...)` 透传一致；避免只用 `.env` 而忽略前端 Key。

### 前端 localStorage（与请求字段对应）

定义见 `lib/ark-settings.ts`：

- `lawlaw_api_key` → 请求里 `api_key`
- `lawlaw_chat_vision_endpoint_id` → `chat_vision_endpoint_id`
- `lawlaw_embedding_endpoint_id` → `embedding_endpoint_id`（上传表单字段 `embedding_endpoint_id`）

旧键 `lawlaw_chat_vision_model_id` / `lawlaw_embedding_model_id` 会在读设置时迁移到新键（仅当新键为空）。

## 5. Embedding 实现要点（`vector_store.py`）

- **BASE**：`EMBEDDING_BASE_URL`（默认 `https://ark.cn-beijing.volces.com/api/v3`），可环境变量覆盖。
- **标准路径**：`POST {BASE}/embeddings`，body `{"model": "...", "input": "<string>"}`（或非 vision 的纯文本模型）。
- **多模态路径**：`POST {BASE}/embeddings/multimodal`，body `{"model": "...", "input": [{"type": "text", "text": "..."}]}`。
- **何时走 multimodal**：`_embedding_uses_multimodal_api(model_id)` — `model_id` 以 `ep-` 开头，或 ID/名称中包含 `embedding-vision`（不区分大小写）。
- **响应解析**：`_extract_embedding_vectors` 兼容多种 JSON 形态（`data[].embedding`、`data` 为对象再递归、顶层 `embedding`/`vector`、`embeddings`/`vectors` 数组、`result`/`output`/`Response`/`response` 嵌套等）。失败时异常与 `logger.error` 中带 `_json_preview` 截断后的原始 JSON。
- **对外入口**：`embed_texts(texts, embedding_model_id=None, api_key=None)`；`upsert_project_chunks` / `query_project_chunks` 将 `api_key` 传入 `embed_texts`。

## 6. RAG 与向量入库

- **入库**：`upsert_project_evidence` 遍历 `iter_evidence_files`（排除 `template` 子目录与 `.zip`），`extract_text_by_file` + `chunk_text`，`evidence_chunk_metadata` 生成 metadata，再 `upsert_project_chunks`。
- **Chroma metadata**（字符串为主）：`project_id`、`doc_name`、`chunk_index`，以及 `source_file`、`doc_type`、可选 `time_stamp`。
- **检索**：`query_project_chunks(..., where=..., api_key=...)`；`build_metadata_where(filter_doc_type, filter_source_file)` 生成 Chroma `where` / `$and`。
- **API**：`RagQueryRequest` 含 `filter_doc_type`、`filter_source_file`（前端当前可不传，后端已支持）。

## 7. HTTP API 一览（`backend/main.py`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/config-check` | 仅反映 **.env** 加载情况（不替代探测） |
| GET | `/api/model-options` | 兼容旧前端；默认列表来自 .env |
| POST | `/api/model-probe` | 探测 Embedding（`embed_texts`）+ Chat（OpenAI SDK）；体：`api_key`、`chat_vision_endpoint_id`、`embedding_endpoint_id` 及 legacy 字段 |
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects` | 列表 |
| GET | `/api/projects/{id}/state` | 文档 + 消息 |
| PUT | `/api/projects/{id}/document` | 保存编辑器文档 |
| POST | `/api/projects/{id}/messages` | 追加聊天消息 |
| DELETE | `/api/projects/{id}/messages` | 清空该项目消息 |
| PATCH | `/api/projects/{id}` | 重命名 |
| DELETE | `/api/projects/{id}` | 删除项目（含上传目录、Chroma collection、关联 DB 行） |
| POST | `/api/upload` | Form：`project_id`、`file`、可选 `api_key`、`embedding_endpoint_id`、`embedding_model_id`；可触发向量入库 |
| POST | `/api/upload-template` | 模板上传到 `template/` |
| POST | `/api/generate` | SSE：法律意见书流式生成（多模态 user content） |
| POST | `/api/rag-query` | JSON RAG + 非流式回答 |
| POST | `/api/rag-query/stream` | SSE RAG |

CORS：允许 `localhost` / `127.0.0.1` 的 3000 等来源（见 `main.py`）。

## 8. 已知缺口 / 注意点

- **RAG metadata 过滤**：后端已支持；**前端未提供** `filter_doc_type` / `filter_source_file` 的 UI。
- **自动化测试**：仓库内无完整 E2E/接口测试套件说明。
- **生产部署**：无内置鉴权、HTTPS、多租户隔离；上传目录在系统临时路径，生产需自行评估持久化与清理策略。
- **调试日志**：`main.py` 中 `debug_log` 可能向 `.cursor/debug-*.log` 写入（若存在相关代码块）。

## 9. 本地开发命令（摘要）

```bash
# 后端（仓库根目录，需已安装 backend/requirements.txt）
uvicorn backend.main:app --reload --port 8000

# 前端
npm install && npm run dev
```

环境变量模板：`backend/.env.example`。
