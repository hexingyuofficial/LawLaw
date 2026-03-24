"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type PartialBlock } from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteViewEditor, BlockNoteViewRaw } from "@blocknote/react";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/react/style.css";

import { Button } from "@/components/ui/button";
import { SourceSheet } from "@/components/workspace/source-sheet";
import { readArkSettingsFromStorage } from "@/lib/ark-settings";

const DEFAULT_PROJECT_ID = 1;

function getBlockText(block: { content?: unknown }) {
  if (!block.content) {
    return "";
  }
  if (typeof block.content === "string") {
    return block.content.replace(/\u200B/g, "");
  }
  if (Array.isArray(block.content)) {
    return block.content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (typeof item === "object" && item && "text" in item) {
          return String(item.text ?? "").replace(/\u200B/g, "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

type BlockNoteEditorRuntimeProps = {
  onDocumentTextChange?: (text: string) => void;
  projectId?: number | null;
};

type StreamEvent =
  | { type: "delta"; content: string }
  | { type: "done" }
  | { type: "error"; message: string };

function getBackendApiUrl(path: string) {
  if (typeof window === "undefined") {
    return `http://localhost:8000${path}`;
  }
  const isLoopbackHost =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const backendHost = isLoopbackHost ? window.location.hostname : "localhost";
  return `${window.location.protocol}//${backendHost}:8000${path}`;
}

function getBackendGenerateUrl() {
  return getBackendApiUrl("/api/generate");
}

function getDocumentText(blocks: { content?: unknown }[]) {
  return blocks.map((block) => getBlockText(block)).join("\n");
}

function BlockNoteEditorRuntime({ onDocumentTextChange, projectId }: BlockNoteEditorRuntimeProps) {
  const [guardMessage, setGuardMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [loadingProjectState, setLoadingProjectState] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [generateHint, setGenerateHint] = useState("");
  const [showEmptyHint, setShowEmptyHint] = useState(true);
  const saveTimerRef = useRef<number | null>(null);
  const loadingAbortRef = useRef<AbortController | null>(null);

  const templateBlocks = useMemo<PartialBlock[]>(
    () => [{ type: "paragraph", content: "\u200B" }],
    [],
  );

  const editor = useCreateBlockNote({
    initialContent: templateBlocks,
  });

  useEffect(() => {
    onDocumentTextChange?.(getDocumentText(editor.document));
  }, [editor, onDocumentTextChange]);

  const buildDocumentBlocks = (fullText: string): PartialBlock[] => [
    { type: "paragraph", content: fullText || "\u200B" },
  ];

  const applyGeneratedDraft = (fullText: string) => {
    const nextBlocks = buildDocumentBlocks(fullText);
    editor.replaceBlocks(editor.document, nextBlocks);
    onDocumentTextChange?.(getDocumentText(editor.document));
  };

  const scheduleDocumentSave = (content: string) => {
    if (!projectId) {
      return;
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      void fetch(getBackendApiUrl(`/api/projects/${projectId}/document`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }).catch(() => {
        // ignore transient save errors; user can continue editing
      });
    }, 800);
  };

  const handleEditorChange = () => {
    const text = getDocumentText(editor.document).trim();
    setShowEmptyHint(!text);
    onDocumentTextChange?.(text);
    scheduleDocumentSave(text);
  };

  useEffect(() => {
    if (loadingAbortRef.current) {
      loadingAbortRef.current.abort();
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!projectId) {
      applyGeneratedDraft("");
      setGenerateHint("");
      return;
    }

    const controller = new AbortController();
    loadingAbortRef.current = controller;
    setLoadingProjectState(true);
    setGenerateError("");
    setGenerateHint("");

    void (async () => {
      try {
        const response = await fetch(getBackendApiUrl(`/api/projects/${projectId}/state`), {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`项目文档加载失败（${response.status}）`);
        }
        const payload = (await response.json()) as { document?: string };
        const text = (payload.document ?? "").trim();
        applyGeneratedDraft(text);
        setShowEmptyHint(!text);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setGenerateError(error instanceof Error ? error.message : "项目文档加载失败");
      } finally {
        if (!controller.signal.aborted) {
          setLoadingProjectState(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    return () => {
      if (loadingAbortRef.current) {
        loadingAbortRef.current.abort();
      }
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  const handleGenerate = async () => {
    setGenerateError("");
    setGenerateHint("");
    const ark = readArkSettingsFromStorage();
    if (!ark.api_key) {
      setGenerateError("请先在左侧齿轮设置里填写 API Key。");
      return;
    }

    setGenerating(true);
    applyGeneratedDraft("");
    setShowEmptyHint(true);

    try {
      const response = await fetch(getBackendGenerateUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId ?? DEFAULT_PROJECT_ID,
          api_key: ark.api_key,
          chat_vision_endpoint_id: ark.chat_vision_endpoint_id,
          embedding_endpoint_id: ark.embedding_endpoint_id,
          instruction: "请生成法律意见书正文。",
        }),
      });

      if (!response.ok || !response.body) {
        const fallback = `生成失败（${response.status}）`;
        let detail = fallback;
        try {
          const body = (await response.json()) as { detail?: string };
          if (body.detail) {
            detail = `${fallback}：${body.detail}`;
          }
        } catch {
          // Keep fallback.
        }
        throw new Error(detail);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let sseBuffer = "";
      let generatedText = "";

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
            const event = JSON.parse(raw) as StreamEvent;
            if (event.type === "delta") {
              generatedText += event.content;
              applyGeneratedDraft(generatedText);
            } else if (event.type === "error") {
              throw new Error(event.message || "模型返回错误");
            } else if (event.type === "done") {
              setGenerateHint("生成完成。");
            }
          }
          boundary = sseBuffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      setGenerateError(error instanceof Error ? error.message : "生成失败，请稍后重试");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-white">
      <div className="flex items-center justify-end gap-2 border-b p-4">
        <Button variant="secondary" onClick={handleGenerate} disabled={generating}>
          {generating ? "生成中..." : "一键生成合规意见"}
        </Button>
        <Button>导出 Word</Button>
        <SourceSheet />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="relative h-full rounded-xl border bg-white p-3">
          {showEmptyHint ? (
            <div className="pointer-events-none absolute left-8 top-8 z-10 text-sm text-zinc-300">
              开始输入，或先在左侧上传资料后再生成内容
            </div>
          ) : null}
          <BlockNoteViewRaw
            editor={editor}
            className="h-full"
            onChange={handleEditorChange}
            formattingToolbar={false}
            linkToolbar={false}
            slashMenu={false}
            sideMenu={false}
            filePanel={false}
            tableHandles={false}
            emojiPicker={false}
            comments={false}
          >
            <BlockNoteViewEditor />
          </BlockNoteViewRaw>
        </div>
        {generateError ? (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{generateError}</p>
        ) : null}
        {generateHint ? (
          <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {generateHint}
          </p>
        ) : null}
        {loadingProjectState ? (
          <p className="mt-3 rounded-md bg-zinc-100 px-3 py-2 text-sm text-zinc-600">正在加载当前项目文档...</p>
        ) : null}
      </div>
    </section>
  );
}

type EditorPanelProps = {
  onDocumentTextChange?: (text: string) => void;
  projectId?: number | null;
};

export function EditorPanel({ onDocumentTextChange, projectId }: EditorPanelProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <section className="flex h-full min-w-0 flex-1 flex-col bg-white">
        <div className="flex items-center justify-end gap-2 border-b p-4">
          <Button variant="secondary">一键生成合规意见</Button>
          <Button>导出 Word</Button>
          <SourceSheet />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="flex h-full items-center justify-center rounded-xl border bg-white text-sm text-zinc-500">
            正在加载本地编辑器...
          </div>
        </div>
      </section>
    );
  }

  return <BlockNoteEditorRuntime onDocumentTextChange={onDocumentTextChange} projectId={projectId} />;
}
