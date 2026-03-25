"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { blocksToMarkdown, markdownToBlocks, type PartialBlock } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useCreateBlockNote } from "@blocknote/react";
import "@blocknote/core/fonts/inter.css";

import { Button } from "@/components/ui/button";
import { CitationPill } from "@/components/workspace/citation-pill";
import { lawLawBlockNoteSchema } from "@/components/workspace/doc-citation-inline";
import { getBackendApiUrl } from "@/lib/backend-url";
import { selectionLineLabel } from "@/lib/citation-parse";
import { injectDocCitationsIntoBlocks } from "@/lib/inject-doc-citations";
import { stripSourceColumnFromMarkdownTables } from "@/lib/strip-markdown-table-source-column";

/**
 * 落库 / 再载入前统一整理 Markdown，减轻 BlockNote「HTML→Markdown→解析」往返放大空行：
 * - 去掉仅含 `\` / `\\` 的行（remark 硬换行占位，再解析易变成空段落，刷新后越积越多）
 * - 折叠 3 个及以上连续换行为双换行
 */
function normalizeMarkdownForPersistence(md: string): string {
  let t = (md ?? "").replace(/\r\n/g, "\n");
  t = t
    .split("\n")
    .filter((line) => {
      const s = line.trim();
      return s !== "\\" && s !== "\\\\";
    })
    .join("\n");
  let prev = "";
  while (t !== prev) {
    prev = t;
    t = t.replace(/\n{3,}/g, "\n\n");
  }
  return t.trim();
}

function isParagraphVisuallyEmpty(block: PartialBlock): boolean {
  if (block.type !== "paragraph") {
    return false;
  }
  const c = block.content;
  if (c == null || c === "") {
    return true;
  }
  if (typeof c === "string") {
    return c.replace(/\u200B/g, "").trim() === "";
  }
  if (Array.isArray(c)) {
    for (const item of c) {
      if (typeof item === "string") {
        if (item.replace(/\u200B/g, "").trim() !== "") {
          return false;
        }
        continue;
      }
      if (item && typeof item === "object" && "type" in item) {
        const t = (item as { type: string }).type;
        if (t === "docCitation") {
          return false;
        }
        if (t === "text") {
          const tx = String((item as { text?: string }).text ?? "").replace(/\u200B/g, "").trim();
          if (tx !== "") {
            return false;
          }
        }
      }
    }
    return true;
  }
  return false;
}

/** 顶层连续空段落压成最多一个，避免 HTML↔MD 往返越堆越多 */
function collapseConsecutiveEmptyParagraphs(blocks: PartialBlock[]): PartialBlock[] {
  const out: PartialBlock[] = [];
  let prevWasEmptyPara = false;
  for (const b of blocks) {
    const empty = isParagraphVisuallyEmpty(b);
    if (empty) {
      if (!prevWasEmptyPara) {
        out.push(b);
        prevWasEmptyPara = true;
      }
      continue;
    }
    prevWasEmptyPara = false;
    out.push(b);
  }
  return out;
}

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
        if (typeof item === "object" && item && "type" in item && (item as { type: string }).type === "docCitation") {
          const p = (item as { props?: { sourceFile?: string } }).props;
          return `[doc:${(p?.sourceFile ?? "").trim()}]`;
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
  documentMarkdown?: string;
  onQuoteSelectionToChat?: (selection: { text: string; label: string }) => void;
};

export type EditorRewriteHandle = {
  applyFullRewriteMarkdown: (markdown: string) => void;
  applyPartialRewriteMarkdown: (replacement: string, selectionText: string) => void;
  /** 将当前编辑器选区送入对话（局部改写用） */
  quoteSelectionToChat: () => { ok: true } | { ok: false; message: string };
};

const BlockNoteEditorRuntime = forwardRef<EditorRewriteHandle, BlockNoteEditorRuntimeProps>(
  function BlockNoteEditorRuntime(
    {
      onDocumentTextChange,
      projectId,
      documentMarkdown = "",
      onQuoteSelectionToChat,
    },
    ref,
  ) {
  const [loadingProjectState, setLoadingProjectState] = useState(false);
  const [documentLoadError, setDocumentLoadError] = useState("");
  const [showEmptyHint, setShowEmptyHint] = useState(true);
  const [exportingDoc, setExportingDoc] = useState(false);
  const [exportError, setExportError] = useState("");
  const saveTimerRef = useRef<number | null>(null);
  const loadingAbortRef = useRef<AbortController | null>(null);

  const templateBlocks = useMemo<PartialBlock[]>(
    () => [{ type: "paragraph", content: "\u200B" }],
    [],
  );

  const editor = useCreateBlockNote({
    schema: lawLawBlockNoteSchema,
    initialContent: templateBlocks,
    // 为方案 B（所见即所得）开启基础结构化编辑能力：标题/列表/表格等。
    // 说明：具体渲染由 @blocknote/mantine 的 BlockNoteView（含 ComponentsContext）控制。
    tables: {
      splitCells: true,
      headers: true,
    },
  });

  const getDocumentMarkdown = (): string => {
    // blocksToMarkdown 需要 editor.pmSchema + editor 实例
    // document 内部结构兼容 PartialBlock（保守 cast，避免泛型类型噪音）
    const markdown = blocksToMarkdown(
      editor.document as unknown as PartialBlock[],
      editor.pmSchema,
      // 自定义 inline schema 与默认 BlockNoteEditor 泛型在 TS 中不完全一致，运行时兼容
      editor as never,
      {},
    );
    return normalizeMarkdownForPersistence(stripSourceColumnFromMarkdownTables(markdown || ""));
  };

  useEffect(() => {
    onDocumentTextChange?.(getDocumentMarkdown());
  }, [editor, onDocumentTextChange]);

  const buildDocumentBlocks = (fullText: string): PartialBlock[] => [
    { type: "paragraph", content: fullText || "\u200B" },
  ];

  const applyGeneratedDraft = (fullText: string) => {
    const nextBlocks = injectDocCitationsIntoBlocks(buildDocumentBlocks(fullText));
    editor.replaceBlocks(editor.document, nextBlocks);
    onDocumentTextChange?.(getDocumentMarkdown());
  };

  const applyLoadedMarkdown = (markdown: string) => {
    const safeMarkdown = normalizeMarkdownForPersistence(
      stripSourceColumnFromMarkdownTables(markdown ?? ""),
    );
    if (!safeMarkdown) {
      applyGeneratedDraft("");
      return;
    }

    try {
      // 将后端 Markdown 还原成结构化 blocks（方案 B 核心）
      const parsedBlocks = markdownToBlocks(safeMarkdown, editor.pmSchema);
      const rawBlocks =
        parsedBlocks && parsedBlocks.length > 0
          ? (parsedBlocks as unknown as PartialBlock[])
          : buildDocumentBlocks(safeMarkdown);
      const nextBlocks = collapseConsecutiveEmptyParagraphs(
        injectDocCitationsIntoBlocks(rawBlocks),
      );
      editor.replaceBlocks(editor.document, nextBlocks);
      onDocumentTextChange?.(getDocumentMarkdown());
    } catch {
      // 解析失败：回退为整段 paragraph（兼容旧项目/异常 Markdown）
      applyGeneratedDraft(safeMarkdown);
    }
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

  const finalizeRewriteToDocument = () => {
    const markdown = getDocumentMarkdown();
    setShowEmptyHint(!markdown);
    onDocumentTextChange?.(markdown);
    scheduleDocumentSave(markdown);
  };

  const quoteSelectionToChatImpl = (): { ok: true } | { ok: false; message: string } => {
    const { blocks } = editor.getSelectionCutBlocks(true);
    if (!blocks.length) {
      return { ok: false, message: "请先选中一段正文。" };
    }
    const text = blocks
      .map((b) => getBlockText(b as { content?: unknown }))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (!text) {
      return { ok: false, message: "当前选区没有可引用的文本。" };
    }
    const label = selectionLineLabel(documentMarkdown, text);
    onQuoteSelectionToChat?.({ text, label });
    return { ok: true };
  };

  useImperativeHandle(
    ref,
    () => ({
      applyFullRewriteMarkdown(md: string) {
        applyLoadedMarkdown(md);
        finalizeRewriteToDocument();
      },
      applyPartialRewriteMarkdown(replacement: string, selectionText: string) {
        const needle = (selectionText ?? "").trim();
        if (!needle) {
          throw new Error("选区文本为空，请重新「引用到对话」。");
        }
        const cur = getDocumentMarkdown();
        const idx = cur.indexOf(needle);
        if (idx === -1) {
          throw new Error("无法在正文中定位原选区，请重新「引用到对话」后再试。");
        }
        const next = cur.slice(0, idx) + replacement + cur.slice(idx + needle.length);
        applyLoadedMarkdown(next);
        finalizeRewriteToDocument();
      },
      quoteSelectionToChat: quoteSelectionToChatImpl,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editor 实例稳定后方法依赖其闭包
    [editor, projectId, onDocumentTextChange, documentMarkdown, onQuoteSelectionToChat],
  );

  const handleEditorChange = () => {
    const markdown = getDocumentMarkdown();
    setShowEmptyHint(!markdown);
    onDocumentTextChange?.(markdown);
    scheduleDocumentSave(markdown);
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
      setDocumentLoadError("");
      return;
    }

    const controller = new AbortController();
    loadingAbortRef.current = controller;
    setLoadingProjectState(true);
    setDocumentLoadError("");

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
        applyLoadedMarkdown(text);
        setShowEmptyHint(!text);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setDocumentLoadError(error instanceof Error ? error.message : "项目文档加载失败");
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

  const handleExportWord = async () => {
    setExportError("");
    if (!projectId) {
      setExportError("请先选择项目。");
      return;
    }
    setExportingDoc(true);
    try {
      const md = getDocumentMarkdown();
      const res = await fetch(getBackendApiUrl(`/api/projects/${projectId}/export/docx`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: md }),
      });
      if (!res.ok) {
        let msg = `导出失败（${res.status}）`;
        try {
          const j = (await res.json()) as { detail?: string };
          if (j.detail) {
            msg += `：${j.detail}`;
          }
        } catch {
          // ignore
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const dispo = res.headers.get("Content-Disposition");
      let filename = `项目${projectId}.docx`;
      const m = dispo?.match(/filename="([^"]+)"/);
      if (m?.[1]) {
        filename = m[1];
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "导出失败，请稍后重试。");
    } finally {
      setExportingDoc(false);
    }
  };

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-white">
      <div className="flex flex-wrap items-center justify-end gap-2 border-b p-4">
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleExportWord()}
          disabled={exportingDoc}
        >
          {exportingDoc ? "导出中..." : "导出 Word"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="relative h-full rounded-xl border bg-white p-3">
          <div className="absolute right-2 top-2 z-20">
            <CitationPill sourceText={documentMarkdown} title="本文档引用文件" />
          </div>
          {showEmptyHint ? (
            <div className="pointer-events-none absolute left-8 top-8 z-10 text-sm text-zinc-300">
              开始输入，或上传资料后在下方「AI 对话 · 全文重写」生成
            </div>
          ) : null}
          <BlockNoteView
            editor={editor}
            className="h-full"
            onChange={handleEditorChange}
            formattingToolbar
            linkToolbar={false}
            slashMenu
            sideMenu={false}
            filePanel={false}
            tableHandles={false}
            emojiPicker={false}
            comments={false}
          />
        </div>
        {documentLoadError ? (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{documentLoadError}</p>
        ) : null}
        {exportError ? (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{exportError}</p>
        ) : null}
        {loadingProjectState ? (
          <p className="mt-3 rounded-md bg-zinc-100 px-3 py-2 text-sm text-zinc-600">正在加载当前项目文档...</p>
        ) : null}
      </div>
    </section>
  );
},
);

BlockNoteEditorRuntime.displayName = "BlockNoteEditorRuntime";

type EditorPanelProps = {
  onDocumentTextChange?: (text: string) => void;
  projectId?: number | null;
  documentMarkdown?: string;
  onQuoteSelectionToChat?: (selection: { text: string; label: string }) => void;
};

export const EditorPanel = forwardRef<EditorRewriteHandle, EditorPanelProps>(function EditorPanel(
  { onDocumentTextChange, projectId, documentMarkdown, onQuoteSelectionToChat },
  ref,
) {
  const innerRef = useRef<EditorRewriteHandle | null>(null);
  const [mounted, setMounted] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      applyFullRewriteMarkdown(md: string) {
        if (!innerRef.current) {
          throw new Error("编辑器未就绪，请稍后再试。");
        }
        innerRef.current.applyFullRewriteMarkdown(md);
      },
      applyPartialRewriteMarkdown(replacement: string, selectionText: string) {
        if (!innerRef.current) {
          throw new Error("编辑器未就绪，请稍后再试。");
        }
        innerRef.current.applyPartialRewriteMarkdown(replacement, selectionText);
      },
      quoteSelectionToChat() {
        if (!innerRef.current) {
          return { ok: false as const, message: "编辑器未就绪，请稍后再试。" };
        }
        return innerRef.current.quoteSelectionToChat();
      },
    }),
    [],
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <section className="flex h-full min-w-0 flex-1 flex-col bg-white">
        <div className="flex items-center justify-end gap-2 border-b p-4">
          <Button variant="outline">导出 Word</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="flex h-full items-center justify-center rounded-xl border bg-white text-sm text-zinc-500">
            正在加载本地编辑器...
          </div>
        </div>
      </section>
    );
  }

  return (
    <BlockNoteEditorRuntime
      ref={innerRef}
      onDocumentTextChange={onDocumentTextChange}
      projectId={projectId}
      documentMarkdown={documentMarkdown}
      onQuoteSelectionToChat={onQuoteSelectionToChat}
    />
  );
});

EditorPanel.displayName = "EditorPanel";
