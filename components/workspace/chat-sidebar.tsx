"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { MessageSquare, Quote, SendHorizonal, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CitationPill } from "@/components/workspace/citation-pill";
import { getBackendApiUrl } from "@/lib/backend-url";
import { readArkSettingsFromStorage } from "@/lib/ark-settings";
import { type EditorRewriteHandle } from "@/components/workspace/editor-panel";
import { extractDocCitations, stripTrailingSourcesBlock } from "@/lib/citation-parse";

/** 若模型用 ``` 围栏包住整篇 Markdown，去掉围栏再写入编辑器 */
function stripOptionalMarkdownFence(s: string): string {
  let t = s.trim();
  if (!t.startsWith("```")) {
    return t;
  }
  const firstNl = t.indexOf("\n");
  if (firstNl === -1) {
    return t;
  }
  t = t.slice(firstNl + 1);
  const lastFence = t.lastIndexOf("```");
  if (lastFence !== -1) {
    t = t.slice(0, lastFence).trimEnd();
  }
  return t.trim();
}

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type ChatStreamEvent =
  | { type: "sources"; sources: string[] }
  | { type: "delta"; content?: string }
  | { type: "done"; sources?: string[] }
  | { type: "error"; message: string }
  | { type: "hint"; message?: string }
  | { type: "progress"; phase?: string; indeterminate?: boolean; message?: string };

type ChatMode = "qa" | "search" | "full_rewrite" | "partial_rewrite";

const CHAT_MODES: { value: ChatMode; label: string }[] = [
  { value: "full_rewrite", label: "全文重写" },
  { value: "partial_rewrite", label: "局部改写" },
  { value: "search", label: "检索" },
  { value: "qa", label: "问答" },
];

type WorkspaceChatPanelProps = {
  projectId?: number | null;
  documentMarkdown?: string;
  editorSelection?: { text: string; label: string } | null;
  onClearEditorSelection?: () => void;
  editorRewriteRef?: RefObject<EditorRewriteHandle | null>;
};

/** 主工作区底部 AI 对话条（约占主栏高度 1/4，由外层 flex 比例控制） */
export function WorkspaceChatPanel({
  projectId,
  documentMarkdown = "",
  editorSelection = null,
  onClearEditorSelection,
  editorRewriteRef,
}: WorkspaceChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [chatMode, setChatMode] = useState<ChatMode>("search");
  const [composeError, setComposeError] = useState("");
  const [asking, setAsking] = useState(false);
  const [streamStatus, setStreamStatus] = useState("");
  const [loadingState, setLoadingState] = useState(false);
  const [quoteActionHint, setQuoteActionHint] = useState("");
  const activeStreamAbortRef = useRef<AbortController | null>(null);
  const stateLoadingAbortRef = useRef<AbortController | null>(null);
  const projectIdRef = useRef<number | null | undefined>(projectId);

  const persistMessage = async (targetProjectId: number, role: "user" | "assistant", content: string) => {
    await fetch(getBackendApiUrl(`/api/projects/${targetProjectId}/messages`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, content }),
    });
  };

  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  useEffect(() => {
    if (activeStreamAbortRef.current) {
      activeStreamAbortRef.current.abort();
      activeStreamAbortRef.current = null;
    }
    setAsking(false);
    if (stateLoadingAbortRef.current) {
      stateLoadingAbortRef.current.abort();
    }
    const controller = new AbortController();
    stateLoadingAbortRef.current = controller;

    if (!projectId) {
      setMessages([]);
      setLoadingState(false);
      return;
    }

    setLoadingState(true);
    setMessages([]);
    void (async () => {
      try {
        const response = await fetch(getBackendApiUrl(`/api/projects/${projectId}/state`), {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`项目对话加载失败（${response.status}）`);
        }
        const payload = (await response.json()) as {
          messages?: Array<{ id: number; role: "user" | "assistant"; content: string }>;
        };
        const loaded = (payload.messages ?? []).map((item) => ({
          id: `db-${item.id}`,
          role: item.role,
          content: item.content,
        }));
        setMessages(loaded);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setMessages([
          {
            id: `err-${Date.now()}`,
            role: "assistant",
            content: error instanceof Error ? error.message : "项目对话加载失败，请稍后重试。",
          },
        ]);
      } finally {
        if (!controller.signal.aborted) {
          setLoadingState(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [projectId]);

  const sendMessage = async () => {
    if (asking) {
      return;
    }
    const text = input.trim();
    if (!text) {
      return;
    }
    if (!projectId) {
      setMessages((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, role: "user", content: text },
        { id: `a-${Date.now()}`, role: "assistant", content: "请先在左侧选择或创建项目。" },
      ]);
      setInput("");
      return;
    }

    const ark = readArkSettingsFromStorage();
    if (!ark.api_key) {
      setMessages((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, role: "user", content: text },
        { id: `a-${Date.now()}`, role: "assistant", content: "请先在左侧齿轮中配置 API Key。" },
      ]);
      setInput("");
      return;
    }

    if (chatMode === "partial_rewrite" && !(editorSelection?.text ?? "").trim()) {
      setComposeError("局部改写需要先在正文中选中内容，再点击上方「引用到对话」。");
      return;
    }
    setComposeError("");

    setAsking(true);
    setStreamStatus("");

    const priorHistory = messages
      .filter((m) => m.content.trim())
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    let streamAssistantId: string | null = null;
    try {
      const requestProjectId = projectId;
      if (!requestProjectId) {
        return;
      }
      void persistMessage(requestProjectId, "user", text);

      const partialSelectionSnapshot =
        chatMode === "partial_rewrite" && editorSelection
          ? { text: editorSelection.text, label: editorSelection.label }
          : null;

      const streamController = new AbortController();
      activeStreamAbortRef.current = streamController;
      streamAssistantId = `a-${Date.now()}`;
      const assistantPlaceholder =
        chatMode === "full_rewrite"
          ? "正在重写全文…"
          : chatMode === "partial_rewrite"
            ? "正在重写选区…"
            : "";
      setMessages((prev) => [
        ...prev,
        { id: streamAssistantId!, role: "assistant", content: assistantPlaceholder },
      ]);

      const selectionPayload = partialSelectionSnapshot
        ? { text: partialSelectionSnapshot.text, label: partialSelectionSnapshot.label }
        : undefined;

      const response = await fetch(
        getBackendApiUrl(`/api/projects/${requestProjectId}/chat/stream`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: streamController.signal,
          body: JSON.stringify({
            mode: chatMode,
            message: text,
            history: priorHistory,
            document_markdown:
              chatMode === "full_rewrite" || chatMode === "partial_rewrite" ? documentMarkdown : "",
            selection: selectionPayload,
            api_key: ark.api_key,
            chat_vision_endpoint_id: ark.chat_vision_endpoint_id,
            embedding_endpoint_id: ark.embedding_endpoint_id,
            top_k: 6,
          }),
        },
      );
      if (!response.ok) {
        let detail = `对话请求失败（${response.status}）`;
        try {
          const body = (await response.json()) as { detail?: string };
          if (body.detail) {
            detail = `${detail}：${body.detail}`;
          }
        } catch {
          // ignore parse error
        }
        throw new Error(detail);
      }
      if (!response.body) {
        throw new Error("流式响应为空");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let sseBuffer = "";
      let answer = "";
      let sources: string[] = [];

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
            const event = JSON.parse(raw) as ChatStreamEvent;

            if (event.type === "sources") {
              sources = event.sources ?? [];
            } else if (event.type === "hint") {
              if (chatMode === "full_rewrite" && event.message) {
                setStreamStatus(event.message);
              }
            } else if (event.type === "progress") {
              if (chatMode === "full_rewrite" && event.message) {
                setStreamStatus(event.message);
              }
            } else if (event.type === "delta") {
              if (projectIdRef.current !== requestProjectId) {
                streamController.abort();
                break;
              }
              answer += event.content ?? "";
              if (chatMode !== "full_rewrite" && chatMode !== "partial_rewrite") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === streamAssistantId ? { ...msg, content: answer } : msg,
                  ),
                );
              }
            } else if (event.type === "error") {
              throw new Error(event.message || "流式对话失败");
            } else if (event.type === "done") {
              if (projectIdRef.current !== requestProjectId) {
                streamController.abort();
                break;
              }
              if (chatMode === "full_rewrite" || chatMode === "partial_rewrite") {
                const cleaned = stripOptionalMarkdownFence(answer.trim());
                if (!cleaned) {
                  setMessages((prev) =>
                    prev.map((msg) =>
                      msg.id === streamAssistantId
                        ? { ...msg, content: "[错误] 模型未返回有效正文。" }
                        : msg,
                    ),
                  );
                } else {
                  try {
                    const ed = editorRewriteRef?.current;
                    if (!ed) {
                      throw new Error("编辑器未就绪，请稍后再试。");
                    }
                    if (chatMode === "full_rewrite") {
                      ed.applyFullRewriteMarkdown(cleaned);
                      setStreamStatus("");
                      setMessages((prev) =>
                        prev.map((msg) =>
                          msg.id === streamAssistantId ? { ...msg, content: "已重写完毕" } : msg,
                        ),
                      );
                      void persistMessage(requestProjectId, "assistant", "已重写完毕");
                    } else {
                      ed.applyPartialRewriteMarkdown(cleaned, partialSelectionSnapshot?.text ?? "");
                      setStreamStatus("");
                      const partialAssistantContent = `### 改写结果（已写入正文）\n\n${cleaned}`;
                      setMessages((prev) =>
                        prev.map((msg) =>
                          msg.id === streamAssistantId
                            ? { ...msg, content: partialAssistantContent }
                            : msg,
                        ),
                      );
                      void persistMessage(requestProjectId, "assistant", partialAssistantContent);
                      onClearEditorSelection?.();
                    }
                  } catch (rewriteErr) {
                    const msg =
                      rewriteErr instanceof Error ? rewriteErr.message : "改写写回失败，请稍后重试。";
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === streamAssistantId ? { ...m, content: `[错误] ${msg}` } : m,
                      ),
                    );
                  }
                }
              } else {
                const finalSources = event.sources?.length ? event.sources : sources;
                const sourceLine =
                  chatMode === "search" && finalSources.length > 0
                    ? `\n\n来源：${finalSources.map((s) => `[doc:${s}]`).join(" ")}`
                    : "";
                const finalContent = `${answer}${sourceLine}`;
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === streamAssistantId ? { ...msg, content: finalContent } : msg,
                  ),
                );
                void persistMessage(requestProjectId, "assistant", finalContent);
              }
            }
          }
          boundary = sseBuffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      const errText = error instanceof Error ? error.message : "对话失败，请稍后重试。";
      setMessages((prev) => {
        if (streamAssistantId) {
          return prev.map((m) =>
            m.id === streamAssistantId
              ? {
                  ...m,
                  content: m.content.trim() ? `${m.content}\n\n[错误] ${errText}` : errText,
                }
              : m,
          );
        }
        return [
          ...prev,
          { id: `a-${Date.now()}`, role: "assistant", content: errText },
        ];
      });
    } finally {
      activeStreamAbortRef.current = null;
      setAsking(false);
      setStreamStatus("");
    }
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-white">
      <div className="shrink-0 border-b border-zinc-200 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-700">
          <MessageSquare className="h-4 w-4 shrink-0" />
          AI 对话
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {CHAT_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => {
                setChatMode(m.value);
                setComposeError("");
                setQuoteActionHint("");
              }}
              disabled={asking}
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
                chatMode === m.value
                  ? "bg-zinc-800 text-white"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {streamStatus.trim() ? (
        <div
          className="shrink-0 border-b border-emerald-200 bg-emerald-50 px-3 py-2.5 shadow-sm"
          role="status"
          aria-live="polite"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800">上下文与 Token</p>
          <p className="mt-0.5 text-xs leading-snug text-emerald-950">{streamStatus}</p>
        </div>
      ) : null}

      {chatMode === "partial_rewrite" ? (
        <div className="shrink-0 border-b border-zinc-200 bg-zinc-50/90 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={asking}
              onClick={() => {
                setComposeError("");
                const ed = editorRewriteRef?.current;
                if (!ed?.quoteSelectionToChat) {
                  setComposeError("编辑器未就绪，请稍后再试。");
                  return;
                }
                const r = ed.quoteSelectionToChat();
                if (!r.ok) {
                  setComposeError(r.message);
                  return;
                }
                setQuoteActionHint("已引用到对话。");
                window.setTimeout(() => setQuoteActionHint(""), 2200);
              }}
            >
              <Quote className="h-3.5 w-3.5" />
              引用到对话
            </Button>
            <span className="text-[11px] leading-snug text-zinc-500">
              在正文中选中一段后点此，选区将出现在下方输入框上方
            </span>
          </div>
          {quoteActionHint ? (
            <p className="mt-1.5 text-[11px] text-emerald-700">{quoteActionHint}</p>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2">
        {loadingState ? (
          <div className="rounded-lg bg-zinc-100 px-2 py-1.5 text-xs text-zinc-600">
            正在加载当前项目对话...
          </div>
        ) : null}
        {messages.map((msg) => {
          const citations = extractDocCitations(msg.content);
          return (
            <div
              key={msg.id}
              className={`relative rounded-lg px-2.5 py-1.5 text-xs leading-relaxed ${
                msg.role === "assistant"
                  ? "bg-zinc-100 text-zinc-700"
                  : "bg-zinc-900 text-zinc-100"
              } ${citations.length > 0 ? "pr-[4.5rem]" : ""}`}
            >
              {citations.length > 0 ? (
                <div className="absolute right-1.5 top-1.5 z-10">
                  <CitationPill sourceText={msg.content} title="本段依据" />
                </div>
              ) : null}
              {msg.role === "assistant" ? (
                msg.content.trim() ? (
                  <div className="prose prose-sm prose-zinc max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeSanitize]}
                    >
                      {stripTrailingSourcesBlock(msg.content)}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <span className="text-zinc-400">…</span>
                )
              ) : (
                <span className="whitespace-pre-wrap">{msg.content}</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="shrink-0 border-t border-zinc-200 p-2">
        {editorSelection?.text?.trim() ? (
          <div className="mb-2 flex items-start gap-2 rounded-md border border-amber-200/80 bg-amber-50/90 px-2 py-1.5 text-[11px] text-amber-950">
            <span className="min-w-0 flex-1">
              <span className="font-medium text-amber-900">已引用选区</span>
              <span className="text-amber-800/90"> · {editorSelection.label}</span>
              <span className="mt-0.5 line-clamp-2 block text-amber-900/80">
                {editorSelection.text}
              </span>
            </span>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-amber-800 hover:bg-amber-100"
              aria-label="清除选区"
              onClick={() => onClearEditorSelection?.()}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        {composeError ? (
          <p className="mb-2 text-[11px] text-red-600">{composeError}</p>
        ) : null}
        <div className="flex gap-2">
          <Input
            className="h-9 text-sm"
            placeholder={
              chatMode === "search"
                ? "基于项目资料检索提问…"
                : chatMode === "qa"
                  ? "法律问题闲聊或咨询…"
                  : chatMode === "full_rewrite"
                    ? "说明如何重写全文（可含首次生成指令）…"
                    : "说明如何重写已引用的选区…"
            }
            value={input}
            disabled={asking}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") {
                return;
              }
              if (event.nativeEvent.isComposing) {
                return;
              }
              event.preventDefault();
              void sendMessage();
            }}
          />
          <Button size="icon" className="h-9 w-9 shrink-0" onClick={() => void sendMessage()} disabled={asking}>
            <SendHorizonal className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
