"use client";

import { useEffect, type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { Copy, MoreVertical, Trash2, UploadCloud } from "lucide-react";

import { useEvidencePreviewBridge } from "@/components/workspace/evidence-preview-bridge-context";
import { getBackendApiUrl } from "@/lib/backend-url";
import { findFileItemByDocSourceFile } from "@/lib/evidence-file-match";
import { type FileItem } from "@/lib/mock-data";
import { readArkSettingsFromStorage } from "@/lib/ark-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type UploadApiFile = {
  name: string;
  type: FileItem["type"];
  rel_path?: string;
  readable?: string;
  unreadable_reason?: string;
};

type UploadApiResponse = {
  project_id: string;
  files: UploadApiFile[];
  total: number;
};

type TemplateUploadApiResponse = {
  project_id: string;
  template_name: string;
  template_type: "PDF" | "WORD" | "其他";
  status: "ok";
};

const DEFAULT_PROJECT_ID = "1";

type FilePoolSidebarProps = {
  documentText?: string;
  projectId?: number | null;
};

function normalizeText(text: string) {
  return text.toLowerCase().replace(/\s+/g, "");
}

function isFileReferenced(fileName: string, documentText: string) {
  const normalizedDoc = normalizeText(documentText);
  if (!normalizedDoc) {
    return false;
  }

  const fullName = normalizeText(fileName);
  const stemName = normalizeText(fileName.replace(/\.[^.]+$/, ""));

  // 方案 B 之后正文是 Markdown；来源标注通常是 `[doc:文件名]`。
  // 为了避免 Markdown 导出/解析过程导致的少量标点差异，这里优先从 `[doc:...]` 中提取文件名再匹配。
  const docMarkers = [...documentText.matchAll(/\\?\[doc\s*:\s*([^\]\\]+)\\?\]/gi)].map((m) => (m[1] ?? "").trim());
  if (docMarkers.length > 0) {
    const normalizedMarkers = docMarkers.map((m) => normalizeText(m));
    const hitFull = normalizedMarkers.some((m) => m === fullName);
    const hitStem = stemName.length > 1 && normalizedMarkers.some((m) => m.includes(stemName));
    if (hitFull || hitStem) {
      return true;
    }
  }

  // 兜底：直接在正文字符串中包含匹配（兼容旧数据/异常情况）
  return normalizedDoc.includes(fullName) || (stemName.length > 1 && normalizedDoc.includes(stemName));
}

export function FilePoolSidebar({ documentText = "", projectId }: FilePoolSidebarProps) {
  const { registerOpenBySourceFile } = useEvidencePreviewBridge();
  const templateInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [templateDragging, setTemplateDragging] = useState(false);
  const [templateUploading, setTemplateUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [templateError, setTemplateError] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [toastMessage, setToastMessage] = useState("");
  const [activeFile, setActiveFile] = useState<FileItem | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"original" | "chunks" | "keyfacts" | "keyfacts_compact">("original");
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [previewText, setPreviewText] = useState<string>("");
  const [chunks, setChunks] = useState<string[]>([]);
  const [chunksMeta, setChunksMeta] = useState<{ total_chunks: number; truncated: boolean } | null>(null);
  const [keyfactsFull, setKeyfactsFull] = useState<string>("");
  const [keyfactsCompact, setKeyfactsCompact] = useState<string>("");
  const [keyfactsLoading, setKeyfactsLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string>("");
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [pathHintFor, setPathHintFor] = useState<string>("");
  const [ocrRebuilding, setOcrRebuilding] = useState(false);
  const [ocrRebuildError, setOcrRebuildError] = useState("");
  const [ocrProgress, setOcrProgress] = useState<{
    current: number;
    total: number;
    message: string;
  } | null>(null);

  const mapType = (type: string): FileItem["type"] => {
    if (
      type === "ZIP" ||
      type === "PDF" ||
      type === "WORD" ||
      type === "图片" ||
      type === "文本" ||
      type === "Excel" ||
      type === "CSV"
    ) {
      return type;
    }
    return "其他";
  };

  const applyUploadedFiles = (uploadedFiles: UploadApiFile[]) => {
    const nextFiles = uploadedFiles.map((file, index) => ({
      id: `u-${index}-${file.name}`,
      name: file.name,
      type: mapType(file.type),
      rel_path: file.rel_path,
      readable: file.readable === "true",
      unreadable_reason: file.unreadable_reason,
      referenced: false,
    }));
    setFiles(nextFiles);
  };

  const loadFiles = async () => {
    if (!projectId) {
      setFiles([]);
      return;
    }
    try {
      const resp = await fetch(getBackendApiUrl(`/api/projects/${projectId}/files`));
      if (!resp.ok) {
        return;
      }
      const data = (await resp.json()) as { files?: UploadApiFile[] };
      applyUploadedFiles(data.files ?? []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const closePreview = () => {
    setPreviewOpen(false);
    setActiveFile(null);
    setActiveTab("original");
    setPreviewError("");
    setPreviewText("");
    setKeyfactsFull("");
    setKeyfactsCompact("");
    setKeyfactsLoading(false);
    setChunks([]);
    setChunksMeta(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewUrl("");
  };

  const openPreview = async (file: FileItem, tab: "original" | "chunks" | "keyfacts" | "keyfacts_compact" = "original") => {
    setActiveFile(file);
    setActiveTab(tab);
    setPreviewOpen(true);
    setPreviewError("");
    setPreviewText("");
    setKeyfactsFull("");
    setKeyfactsCompact("");
    setKeyfactsLoading(tab === "keyfacts" || tab === "keyfacts_compact");
    setChunks([]);
    setChunksMeta(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl("");
    }
    if (!projectId) {
      setPreviewError("请先选择项目。");
      setKeyfactsLoading(false);
      return;
    }
    if (!file.rel_path) {
      setPreviewError("该文件缺少定位信息（rel_path）。请重新上传或刷新列表。");
      setKeyfactsLoading(false);
      return;
    }
    if (file.readable === false) {
      setPreviewError(file.unreadable_reason || "该文件类型不会被读取，也不会进入模型。");
      setKeyfactsLoading(false);
      return;
    }
    try {
      if (tab === "original") {
        const resp = await fetch(
          getBackendApiUrl(`/api/projects/${projectId}/evidence/preview?rel_path=${encodeURIComponent(file.rel_path)}`),
        );
        if (!resp.ok) {
          const body = (await resp.text().catch(() => "")) || `预览失败（${resp.status}）`;
          throw new Error(body);
        }
        const ct = resp.headers.get("content-type")?.toLowerCase() ?? "";
        if (ct.includes("text/plain") || ct.includes("text/")) {
          const text = await resp.text();
          setPreviewText(text);
          return;
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
      } else if (tab === "chunks") {
        const resp = await fetch(
          getBackendApiUrl(`/api/projects/${projectId}/evidence/chunks?rel_path=${encodeURIComponent(file.rel_path)}`),
        );
        if (!resp.ok) {
          const body = (await resp.text().catch(() => "")) || `切块预览失败（${resp.status}）`;
          throw new Error(body);
        }
        const data = (await resp.json()) as { chunks?: string[]; total_chunks?: number; truncated?: boolean };
        setChunks(data.chunks ?? []);
        setChunksMeta({ total_chunks: data.total_chunks ?? (data.chunks?.length ?? 0), truncated: Boolean(data.truncated) });
      } else {
        const resp = await fetch(
          getBackendApiUrl(`/api/projects/${projectId}/evidence/keyfacts?rel_path=${encodeURIComponent(file.rel_path)}`),
        );
        if (!resp.ok) {
          const body = (await resp.text().catch(() => "")) || `KeyFacts 读取失败（${resp.status}）`;
          throw new Error(body);
        }
        const data = (await resp.json()) as {
          status?: string;
          keyfacts_full?: string;
          keyfacts_compact?: string;
          message?: string;
        };
        if (data.status !== "ok") {
          setPreviewError(data.message || "未生成 KeyFacts，请先使用重新扫描 OCR 并重建向量。");
          setKeyfactsLoading(false);
          return;
        }
        setKeyfactsFull(data.keyfacts_full ?? "");
        setKeyfactsCompact(data.keyfacts_compact ?? "");
        setKeyfactsLoading(false);
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "预览失败");
      setKeyfactsLoading(false);
    }
  };

  const filesRef = useRef(files);
  filesRef.current = files;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const openPreviewRef = useRef(openPreview);
  openPreviewRef.current = openPreview;

  useEffect(() => {
    registerOpenBySourceFile((sourceFile: string) => {
      if (!projectIdRef.current) {
        setToastMessage("请先选择项目。");
        window.setTimeout(() => setToastMessage(""), 3200);
        return;
      }
      const file = findFileItemByDocSourceFile(filesRef.current, sourceFile);
      if (!file) {
        setToastMessage(`未在证据池中找到：${(sourceFile || "").trim() || "（空文件名）"}`);
        window.setTimeout(() => setToastMessage(""), 4200);
        return;
      }
      void openPreviewRef.current(file, "original");
    });
    return () => registerOpenBySourceFile(null);
  }, [registerOpenBySourceFile]);

  const deleteEvidence = async (file: FileItem) => {
    if (!projectId) {
      setErrorMessage("请先选择项目。");
      return;
    }
    if (!file.rel_path) {
      setErrorMessage("该文件缺少定位信息（rel_path）。");
      return;
    }
    try {
      const ark = readArkSettingsFromStorage();
      const resp = await fetch(getBackendApiUrl("/api/evidence/delete"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          rel_path: file.rel_path,
          api_key: ark.api_key,
          embedding_endpoint_id: ark.embedding_endpoint_id,
          chat_vision_endpoint_id: ark.chat_vision_endpoint_id,
        }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string };
        throw new Error(body.detail || `删除失败（${resp.status}）`);
      }
      const data = (await resp.json()) as { files?: UploadApiFile[] };
      applyUploadedFiles(data.files ?? []);
      if (activeFile?.id === file.id) {
        closePreview();
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "删除失败");
    }
  };

  const rebuildOcrAndReembed = async (relPath: string) => {
    if (!projectId) {
      setOcrRebuildError("请先选择项目。");
      return;
    }

    try {
      setOcrRebuildError("");
      setOcrProgress(null);
      setOcrRebuilding(true);

      const ark = readArkSettingsFromStorage();
      if (!ark.api_key) {
        setOcrRebuildError("请先在齿轮设置里填写 API Key。");
        return;
      }
      if (!ark.chat_vision_endpoint_id) {
        setOcrRebuildError("缺少 chat_vision_endpoint_id，请在侧栏填写。");
        return;
      }
      if (!ark.embedding_endpoint_id) {
        setOcrRebuildError("缺少 embedding_endpoint_id，请在侧栏填写。");
        return;
      }

      const resp = await fetch(getBackendApiUrl(`/api/projects/${projectId}/ocr/rebuild`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: ark.api_key,
          chat_vision_endpoint_id: ark.chat_vision_endpoint_id,
          embedding_endpoint_id: ark.embedding_endpoint_id,
          rel_path: relPath ?? "",
          stream: true,
        }),
      });

      if (!resp.ok || !resp.body) {
        let detail = `重新扫描失败（${resp.status}）`;
        try {
          const body = (await resp.json().catch(() => ({}))) as { detail?: string };
          if (body.detail) {
            detail = `${detail}：${body.detail}`;
          }
        } catch {
          // ignore
        }
        throw new Error(detail);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        sseBuffer += decoder.decode(value, { stream: true });

        let boundary = sseBuffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = sseBuffer.slice(0, boundary);
          sseBuffer = sseBuffer.slice(boundary + 2);

          const dataLine = block
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.startsWith("data:"));
          if (dataLine) {
            const raw = dataLine.replace(/^data:\s*/, "");
            const event = JSON.parse(raw) as
              | { type: "progress"; phase?: string; current?: number; total?: number; message?: string }
              | { type: "done"; files?: UploadApiFile[]; ok?: boolean }
              | { type: "error"; message?: string };

            if (event.type === "progress") {
              setOcrProgress({
                current: event.current ?? 0,
                total: Math.max(1, event.total ?? 1),
                message: event.message ?? "",
              });
            } else if (event.type === "error") {
              throw new Error(event.message || "重新扫描失败");
            } else if (event.type === "done") {
              if (event.files && event.files.length >= 0) {
                applyUploadedFiles(event.files);
              } else {
                await loadFiles();
              }
              setOcrProgress(null);
              if (previewOpen && activeFile && (relPath === "" || activeFile.rel_path === relPath)) {
                void openPreview(activeFile, activeTab);
              }
            }
          }
          boundary = sseBuffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      setOcrRebuildError(err instanceof Error ? err.message : "重新扫描失败，请稍后重试");
    } finally {
      setOcrRebuilding(false);
      setOcrProgress(null);
    }
  };

  const fetchPathHint = async (file: FileItem) => {
    if (!projectId || !file.rel_path) {
      return;
    }
    try {
      const resp = await fetch(
        getBackendApiUrl(`/api/projects/${projectId}/evidence/path?rel_path=${encodeURIComponent(file.rel_path)}`),
      );
      if (!resp.ok) {
        return;
      }
      const data = (await resp.json()) as { abs_path?: string };
      if (data.abs_path) {
        setPathHintFor(data.abs_path);
      }
    } catch {
      // ignore
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("已复制路径");
    } catch {
      // ignore
    }
  };

  const showToast = (message: string) => {
    setToastMessage(message);
    window.setTimeout(() => setToastMessage(""), 1600);
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    setErrorMessage("");
    try {
      const formData = new FormData();
      formData.append("project_id", String(projectId ?? DEFAULT_PROJECT_ID));
      const ark = readArkSettingsFromStorage();
      if (ark.api_key) {
        formData.append("api_key", ark.api_key);
      }
      if (ark.embedding_endpoint_id) {
        formData.append("embedding_endpoint_id", ark.embedding_endpoint_id);
      }
      if (ark.chat_vision_endpoint_id) {
        formData.append("chat_vision_endpoint_id", ark.chat_vision_endpoint_id);
      }
      formData.append("file", file);

      const response = await fetch(getBackendApiUrl("/api/upload"), {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let detail = `上传失败（${response.status}）`;
        try {
          const body = (await response.json()) as { detail?: string };
          if (body.detail) {
            detail = `${detail}：${body.detail}`;
          }
        } catch {
          // Keep fallback message when response is not json.
        }
        throw new Error(detail);
      }

      const data = (await response.json()) as UploadApiResponse;
      applyUploadedFiles(data.files ?? []);
    } catch (error) {
      if (error instanceof TypeError) {
        setErrorMessage("上传失败：无法连接后端，请确认 FastAPI 正在 8000 端口运行且 CORS 已放行。");
      } else {
        setErrorMessage(error instanceof Error ? error.message : "上传失败，请稍后重试");
      }
    } finally {
      setUploading(false);
    }
  };

  const uploadTemplate = async (file: File) => {
    setTemplateUploading(true);
    setTemplateError("");
    try {
      const formData = new FormData();
      formData.append("project_id", String(projectId ?? DEFAULT_PROJECT_ID));
      formData.append("file", file);

      const response = await fetch(getBackendApiUrl("/api/upload-template"), {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let detail = `模板上传失败（${response.status}）`;
        try {
          const body = (await response.json()) as { detail?: string };
          if (body.detail) {
            detail = `${detail}：${body.detail}`;
          }
        } catch {
          // keep fallback
        }
        throw new Error(detail);
      }

      const data = (await response.json()) as TemplateUploadApiResponse;
      if (data.status !== "ok") {
        throw new Error("模板上传失败：状态异常");
      }
      setTemplateName(data.template_name);
    } catch (error) {
      if (error instanceof TypeError) {
        setTemplateError("模板上传失败：无法连接后端，请确认 FastAPI 正在 8000 端口运行。");
      } else {
        setTemplateError(error instanceof Error ? error.message : "模板上传失败，请稍后重试");
      }
    } finally {
      setTemplateUploading(false);
    }
  };

  const handleInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    await uploadFile(file);
    event.target.value = "";
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) {
      return;
    }
    await uploadFile(file);
  };

  const handleTemplateInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    await uploadTemplate(file);
    event.target.value = "";
  };

  const handleTemplateDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setTemplateDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) {
      return;
    }
    await uploadTemplate(file);
  };

  return (
    <section className="min-h-0 bg-zinc-50 p-4">
      {toastMessage ? (
        <div className="mb-3 rounded-md border border-emerald-700/40 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {toastMessage}
        </div>
      ) : null}
      <Dialog open={previewOpen} onOpenChange={(open) => (open ? setPreviewOpen(true) : closePreview())}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>证据预览</DialogTitle>
            <DialogDescription>
              {activeFile ? `${activeFile.name}（${activeFile.type}）` : "选择一个文件进行预览"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={activeTab === "original" ? "default" : "secondary"}
              onClick={() => activeFile && void openPreview(activeFile, "original")}
              disabled={!activeFile}
            >
              原文预览
            </Button>
            <Button
              variant={activeTab === "chunks" ? "default" : "secondary"}
              onClick={() => activeFile && void openPreview(activeFile, "chunks")}
              disabled={!activeFile}
            >
              抽取/切块
            </Button>
            <Button
              variant={activeTab === "keyfacts" ? "default" : "secondary"}
              onClick={() => activeFile && void openPreview(activeFile, "keyfacts")}
              disabled={!activeFile}
            >
              关键要素汇总
            </Button>
            <Button
              variant={activeTab === "keyfacts_compact" ? "default" : "secondary"}
              onClick={() => activeFile && void openPreview(activeFile, "keyfacts_compact")}
              disabled={!activeFile}
            >
              压缩后内容
            </Button>
          </div>
          <div className="mt-3 h-[60vh] overflow-auto rounded-md border bg-white p-3">
            {previewError ? <p className="text-sm text-red-700">{previewError}</p> : null}
            {!previewError && activeTab === "original" ? (
              previewText ? (
                <pre className="whitespace-pre-wrap break-words text-xs text-zinc-800">{previewText}</pre>
              ) : previewUrl ? (
                activeFile?.type === "PDF" ? (
                  <iframe className="h-full w-full" src={previewUrl} />
                ) : (
                  <img className="mx-auto max-h-[55vh] w-auto" src={previewUrl} alt={activeFile?.name ?? "preview"} />
                )
              ) : (
                <p className="text-sm text-zinc-500">正在加载预览...</p>
              )
            ) : null}
            {!previewError && activeTab === "chunks" ? (
              chunks.length > 0 ? (
                <div className="space-y-3">
                  {chunksMeta ? (
                    <p className="text-xs text-zinc-500">
                      共 {chunksMeta.total_chunks} 段{chunksMeta.truncated ? "（已截断展示）" : ""}
                    </p>
                  ) : null}
                  {chunks.map((chunk, idx) => (
                    <div key={`${idx}`} className="rounded-md border bg-zinc-50 p-2">
                      <p className="mb-1 text-[11px] text-zinc-500">chunk #{idx + 1}</p>
                      <pre className="whitespace-pre-wrap break-words text-xs text-zinc-800">{chunk}</pre>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-zinc-500">未抽取到可切块的文本（图片目前不做 OCR）。</p>
              )
            ) : null}
            {!previewError && activeTab === "keyfacts" ? (
              keyfactsLoading ? (
                <p className="text-sm text-zinc-500">正在加载 KeyFacts...</p>
              ) : keyfactsFull ? (
                <pre className="whitespace-pre-wrap break-words text-xs text-zinc-800">{keyfactsFull}</pre>
              ) : (
                <p className="text-sm text-zinc-500">KeyFacts 尚未生成或内容为空。</p>
              )
            ) : null}
            {!previewError && activeTab === "keyfacts_compact" ? (
              keyfactsLoading ? (
                <p className="text-sm text-zinc-500">正在加载 KeyFacts（压缩版）...</p>
              ) : keyfactsCompact ? (
                <pre className="whitespace-pre-wrap break-words text-xs text-zinc-800">{keyfactsCompact}</pre>
              ) : (
                <p className="text-sm text-zinc-500">KeyFacts（压缩版）尚未生成或内容为空。</p>
              )
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={closePreview}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div
        onClick={() => templateInputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setTemplateDragging(true);
        }}
        onDragLeave={() => setTemplateDragging(false)}
        onDrop={handleTemplateDrop}
        className={`mb-4 rounded-xl border-2 border-dashed p-4 text-center transition ${
          templateDragging ? "border-amber-500 bg-amber-50" : "border-amber-300 bg-amber-50/60"
        } ${templateUploading ? "cursor-wait opacity-70" : "cursor-pointer"}`}
      >
        <input
          ref={templateInputRef}
          type="file"
          className="hidden"
          onChange={handleTemplateInputChange}
          accept=".pdf,.doc,.docx"
        />
        <p className="text-sm font-semibold text-amber-900">
          {templateUploading ? "模板上传中..." : "上传参考模板 (PDF/Word)"}
        </p>
        <p className="mt-1 text-xs text-amber-700">用于对齐文书格式与语气，不进入证据池。</p>
        <p className="mt-2 text-xs text-amber-800">
          {templateName ? `已上传：${templateName}` : "未上传参考模板"}
        </p>
      </div>
      {templateError ? (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{templateError}</p>
      ) : null}

      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`mb-4 rounded-xl border-2 border-dashed p-6 text-center transition ${
          dragging ? "border-blue-500 bg-blue-50" : "border-zinc-300 bg-white"
        } ${uploading ? "cursor-wait opacity-70" : "cursor-pointer"}`}
      >
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={handleInputChange}
          accept=".zip,.pdf,.doc,.docx,.png,.jpg,.jpeg,.txt,.md,.xlsx,.xls,.csv"
        />
        <UploadCloud className="mx-auto mb-2 h-8 w-8 text-zinc-500" />
        <p className="text-sm font-medium">{uploading ? "上传处理中..." : "拖拽文件到这里上传"}</p>
        <p className="text-xs text-zinc-500">
          支持：ZIP、PDF、Word（.doc / .docx；.doc 仅存档、不会被读取）、Excel（.xlsx；.xls
          优先 Python 转换，失败时可装 LibreOffice 兜底）、CSV、PNG / JPG / JPEG、TXT、MD（与后端白名单一致）。
        </p>
      </div>
      {errorMessage ? (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{errorMessage}</p>
      ) : null}
      {ocrRebuildError ? (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{ocrRebuildError}</p>
      ) : null}
      {ocrProgress ? (
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
          <progress
            className="mb-1 h-2 w-full overflow-hidden rounded-full accent-blue-600"
            value={ocrProgress.current}
            max={ocrProgress.total}
          />
          <p className="text-xs text-zinc-600">{ocrProgress.message}</p>
        </div>
      ) : null}
      <Button
        variant="secondary"
        className="mb-4 w-full"
        onClick={() => void rebuildOcrAndReembed("")}
        disabled={ocrRebuilding || uploading}
      >
        {ocrRebuilding ? "重新扫描 OCR 并重建向量中..." : "重新扫描 OCR 并重建向量"}
      </Button>
      <p className="mb-4 text-xs leading-relaxed text-zinc-500">
        重新扫描与下方「AI 对话」、正文编辑互不阻塞，可同时进行（各自独立请求）。
      </p>

      <div className="space-y-2">
        {files.map((file) => (
          <div
            key={file.id}
            className="flex items-center justify-between rounded-lg border bg-white px-3 py-2"
          >
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => void openPreview(file, "original")}
            >
              <p className="text-sm font-medium text-zinc-800">{file.name}</p>
              <p className="text-xs text-zinc-500">
                {file.type}
                {file.readable === false ? (
                  <span className="ml-2 text-xs text-amber-700">
                    （不会被读取/不会进入模型）
                  </span>
                ) : null}
              </p>
            </button>
            <div className="ml-3 flex items-center gap-2">
              <div className="relative">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => {
                    setMenuOpenFor((prev) => (prev === file.id ? null : file.id));
                    void fetchPathHint(file);
                  }}
                  title="更多操作"
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
                {menuOpenFor === file.id ? (
                  <div className="absolute right-0 top-9 z-20 w-48 rounded-md border bg-white p-1 shadow">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-zinc-100"
                      onClick={() => {
                        setMenuOpenFor(null);
                        void openPreview(file, "original");
                      }}
                      disabled={file.readable === false}
                    >
                      预览
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-zinc-100"
                      onClick={() => {
                        setMenuOpenFor(null);
                        void openPreview(file, "chunks");
                      }}
                      disabled={file.readable === false}
                    >
                      查看切块
                    </button>
                    {file.readable === false ? null : (file.type === "PDF" || file.type === "图片") ? (
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-zinc-100"
                        onClick={() => {
                          setMenuOpenFor(null);
                          if (file.rel_path) {
                            void rebuildOcrAndReembed(file.rel_path);
                          }
                        }}
                        disabled={ocrRebuilding}
                        title="仅对 OCR 缓存缺失或为空的内容重新扫描"
                      >
                        重新 OCR 并重建向量
                      </button>
                    ) : null}
                    {file.readable === false ? (
                      <div className="px-2 py-2 text-xs text-amber-700">
                        {file.unreadable_reason || "该文件不会被读取。"}
                      </div>
                    ) : null}
                    {pathHintFor ? (
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-zinc-100"
                        onClick={() => void copyToClipboard(pathHintFor)}
                        title={pathHintFor}
                      >
                        <Copy className="h-4 w-4" />
                        复制路径
                      </button>
                    ) : (
                      <div className="px-2 py-2 text-xs text-zinc-500">路径加载中...</div>
                    )}
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm text-red-700 hover:bg-red-50"
                      onClick={() => {
                        setMenuOpenFor(null);
                        void deleteEvidence(file);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      删除（重建向量）
                    </button>
                  </div>
                ) : null}
              </div>
            {isFileReferenced(file.name, documentText) ? (
              <Badge variant="success">已引用</Badge>
            ) : (
              <Badge variant="muted">未引用</Badge>
            )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
