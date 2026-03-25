"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { EvidencePreviewBridgeProvider } from "@/components/workspace/evidence-preview-bridge-context";
import { WorkspaceChatPanel } from "@/components/workspace/chat-sidebar";
import { EditorPanel, type EditorRewriteHandle } from "@/components/workspace/editor-panel";
import { FilePoolSidebar } from "@/components/workspace/file-pool-sidebar";
import { ProjectSidebar } from "@/components/workspace/project-sidebar";

const CHAT_HEIGHT_STORAGE_KEY = "lawlaw_workspace_chat_height_px";
const MIN_CHAT_PX = 168;
const MIN_EDITOR_PX = 160;
const HANDLE_PX = 6;
const DEFAULT_CHAT_HEIGHT_RATIO = 0.22;

function clampChatHeight(px: number, columnHeight: number): number {
  if (columnHeight <= 0) {
    return px;
  }
  const maxByRatio = Math.round(columnHeight * 0.75);
  const maxByEditor = columnHeight - HANDLE_PX - MIN_EDITOR_PX;
  const maxChat = Math.max(MIN_CHAT_PX, Math.min(maxByRatio, maxByEditor));
  return Math.max(MIN_CHAT_PX, Math.min(maxChat, Math.round(px)));
}

export default function HomePage() {
  const [documentText, setDocumentText] = useState("");
  const [editorSelection, setEditorSelection] = useState<{ text: string; label: string } | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);

  const editorRewriteRef = useRef<EditorRewriteHandle | null>(null);
  const workspaceColumnRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const [chatPaneHeightPx, setChatPaneHeightPx] = useState(260);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const lastSavedHeightRef = useRef(260);

  useEffect(() => {
    setEditorSelection(null);
  }, [selectedProjectId]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHAT_HEIGHT_STORAGE_KEY);
      if (!raw) {
        const fallback = Math.round(window.innerHeight * DEFAULT_CHAT_HEIGHT_RATIO);
        setChatPaneHeightPx(Math.max(MIN_CHAT_PX, fallback));
        return;
      }
      const n = parseInt(raw, 10);
      if (!Number.isNaN(n) && n >= MIN_CHAT_PX) {
        setChatPaneHeightPx(n);
        lastSavedHeightRef.current = n;
      }
    } catch {
      // ignore
    }
  }, []);

  const endDrag = useCallback((e: PointerEvent) => {
    if (dragRef.current === null) {
      return;
    }
    dragRef.current = null;
    try {
      localStorage.setItem(CHAT_HEIGHT_STORAGE_KEY, String(lastSavedHeightRef.current));
    } catch {
      // ignore
    }
    const handleEl = resizeHandleRef.current;
    if (handleEl?.hasPointerCapture(e.pointerId)) {
      handleEl.releasePointerCapture(e.pointerId);
    }
  }, []);

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const col = workspaceColumnRef.current;
    const h = col?.getBoundingClientRect().height ?? 0;
    const startH = clampChatHeight(chatPaneHeightPx, h);
    dragRef.current = { startY: e.clientY, startHeight: startH };
    lastSavedHeightRef.current = startH;
    e.currentTarget.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (dragRef.current === null) {
        return;
      }
      const colEl = workspaceColumnRef.current;
      const ch = colEl?.getBoundingClientRect().height ?? 0;
      // 与鼠标同向：向上拖 → 对话区变高（分界线上移）；向下拖 → 对话区变矮
      const delta = ev.clientY - dragRef.current.startY;
      const next = clampChatHeight(dragRef.current.startHeight - delta, ch);
      lastSavedHeightRef.current = next;
      setChatPaneHeightPx(next);
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      endDrag(ev);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [chatPaneHeightPx, endDrag]);

  useEffect(() => {
    const onResize = () => {
      const col = workspaceColumnRef.current;
      const h = col?.getBoundingClientRect().height ?? 0;
      if (h <= 0) {
        return;
      }
      setChatPaneHeightPx((prev) => clampChatHeight(prev, h));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <main className="h-screen w-screen overflow-x-auto overflow-y-hidden bg-zinc-100">
      <EvidencePreviewBridgeProvider>
      <div className="flex h-full min-w-[1400px]">
        <ProjectSidebar
          selectedProjectId={selectedProjectId}
          onSelectProject={setSelectedProjectId}
        />
        <aside className="flex h-full w-[360px] shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-zinc-50">
          <div className="shrink-0 border-b border-zinc-200 bg-white px-4 py-2.5">
            <h2 className="text-sm font-semibold text-zinc-800">证据与资料</h2>
            <p className="mt-0.5 text-xs text-zinc-500">上传、预览与 OCR</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FilePoolSidebar projectId={selectedProjectId} documentText={documentText} />
          </div>
        </aside>
        <div
          ref={workspaceColumnRef}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <EditorPanel
              ref={editorRewriteRef}
              onDocumentTextChange={setDocumentText}
              projectId={selectedProjectId}
              documentMarkdown={documentText}
              onQuoteSelectionToChat={setEditorSelection}
            />
          </div>
          <div
            ref={resizeHandleRef}
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整编辑器与对话区域高度"
            className="group relative z-10 h-1.5 shrink-0 cursor-row-resize border-y border-zinc-200/80 bg-zinc-200/90 transition-colors hover:bg-zinc-300 active:bg-zinc-400"
            onPointerDown={onResizePointerDown}
          >
            <span className="pointer-events-none absolute inset-x-0 top-1/2 mx-auto h-0.5 w-8 -translate-y-1/2 rounded-full bg-zinc-400/80 opacity-0 group-hover:opacity-100" />
          </div>
          <div
            className="flex shrink-0 flex-col overflow-hidden border-t border-zinc-200 bg-zinc-50 shadow-[0_-6px_16px_rgba(0,0,0,0.06)]"
            style={{ height: chatPaneHeightPx, minHeight: MIN_CHAT_PX }}
          >
            <WorkspaceChatPanel
              projectId={selectedProjectId}
              documentMarkdown={documentText}
              editorSelection={editorSelection}
              onClearEditorSelection={() => setEditorSelection(null)}
              editorRewriteRef={editorRewriteRef}
            />
          </div>
        </div>
      </div>
      </EvidencePreviewBridgeProvider>
    </main>
  );
}
