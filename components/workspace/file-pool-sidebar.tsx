"use client";

import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";

import { type FileItem } from "@/lib/mock-data";
import { readArkSettingsFromStorage } from "@/lib/ark-settings";
import { Badge } from "@/components/ui/badge";

type UploadApiFile = {
  name: string;
  type: FileItem["type"];
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

const getBackendApiUrl = (path: string) => {
  if (typeof window === "undefined") {
    return `http://localhost:8000${path}`;
  }
  const isLoopbackHost =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const backendHost = isLoopbackHost ? window.location.hostname : "localhost";
  return `${window.location.protocol}//${backendHost}:8000${path}`;
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
  return normalizedDoc.includes(fullName) || (stemName.length > 1 && normalizedDoc.includes(stemName));
}

export function FilePoolSidebar({ documentText = "", projectId }: FilePoolSidebarProps) {
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

  const mapType = (type: string): FileItem["type"] => {
    if (type === "ZIP" || type === "PDF" || type === "WORD" || type === "图片") {
      return type;
    }
    return "其他";
  };

  const applyUploadedFiles = (uploadedFiles: UploadApiFile[]) => {
    const nextFiles = uploadedFiles.map((file, index) => ({
      id: `u-${index}-${file.name}`,
      name: file.name,
      type: mapType(file.type),
      referenced: false,
    }));
    setFiles(nextFiles);
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
    <section className="h-full bg-zinc-50 p-4">
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
          accept=".zip,.pdf,.doc,.docx,.png,.jpg,.jpeg"
        />
        <UploadCloud className="mx-auto mb-2 h-8 w-8 text-zinc-500" />
        <p className="text-sm font-medium">{uploading ? "上传处理中..." : "拖拽文件到这里上传"}</p>
        <p className="text-xs text-zinc-500">支持 ZIP / PDF / 图片</p>
      </div>
      {errorMessage ? (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{errorMessage}</p>
      ) : null}

      <div className="space-y-2">
        {files.map((file) => (
          <div key={file.id} className="flex items-center justify-between rounded-lg border bg-white px-3 py-2">
            <div>
              <p className="text-sm font-medium text-zinc-800">{file.name}</p>
              <p className="text-xs text-zinc-500">{file.type}</p>
            </div>
            {isFileReferenced(file.name, documentText) ? (
              <Badge variant="success">已引用</Badge>
            ) : (
              <Badge variant="muted">未引用</Badge>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
