"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { MessageSquare, Quote, SendHorizonal, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CitationPill } from "@/components/workspace/citation-pill";
import { getBackendApiUrl, getBackendSseUrl } from "@/lib/backend-url";
import { readArkSettingsFromStorage } from "@/lib/ark-settings";
import { type EditorRewriteHandle } from "@/components/workspace/editor-panel";
import { extractDocCitations, stripTrailingSourcesBlock } from "@/lib/citation-parse";
import {
  readQaNativeWebSearchFromStorage,
  writeQaNativeWebSearchToStorage,
} from "@/lib/chat-ui-settings";

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

const QA_ANS_BEGIN_RE = /<<<\s*LAWLAW_ANSWER\s*>>>/i;
const QA_ANS_END_RE = /<<<\s*END_LAWLAW_ANSWER\s*>>>/i;

function stripQaToolTags(text: string): string {
  let t = (text ?? "").trim();
  if (!t) return "";
  t = t.replace(/<\/?seed:[^>]*>/gi, " ");
  t = t.replace(/seed:tool_call[^\n\r]*/gi, " ");
  t = t.replace(/<think>.*?<\/think>/gis, " ");
  t = t.replace(/【\s*(思考|推理|推断)\s*】/g, " ");
  t = t.replace(/(思考过程|推理过程|推断)[:：]\s*/gi, "");
  return t.trim();
}

const QA_META_LINE_PREFIXES = [
  "用户现在",
  "首先按照",
  "首先，",
  "首先 ",
  "要先调用",
  "需要调用",
  "所以先",
  "按照要求",
  "不对不对",
  "哦不对",
  "哦对",
  "等下",
  "等一下",
  "对吧",
  "对不对",
  "要不要输出",
  "思考过程",
  "推理过程",
];

function qaFallbackStripMetaLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) {
      out.push(line);
      continue;
    }
    if (QA_META_LINE_PREFIXES.some((p) => s.startsWith(p))) continue;
    const low = s.toLowerCase();
    if (low.includes("web_search") || low.includes("tool_call")) continue;
    if (/^(不对|对，|对。|嗯|呃|哦)/.test(s)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 与后端 _extract_qa_answer 对齐：优先解析分隔符，否则启发式去内心独白行 */
function extractQaAnswerForDisplay(text: string): string {
  let t = stripQaToolTags(text);
  if (!t) return "";
  t = t.replace(/<<<\s*END_LAWLAW_ANSWER\s*>>>\s*$/gim, "").trim();
  QA_ANS_BEGIN_RE.lastIndex = 0;
  const beginM = QA_ANS_BEGIN_RE.exec(t);
  if (beginM?.index !== undefined) {
    const afterBegin = t.slice(beginM.index + beginM[0].length);
    QA_ANS_END_RE.lastIndex = 0;
    const endM = QA_ANS_END_RE.exec(afterBegin);
    if (endM?.index !== undefined) {
      return afterBegin
        .slice(0, endM.index)
        .replace(/<<<\s*END_LAWLAW_ANSWER\s*>>>\s*$/gim, "")
        .trim();
    }
    return afterBegin.replace(/<<<\s*END_LAWLAW_ANSWER\s*>>>\s*$/gim, "").trim();
  }
  return qaFallbackStripMetaLines(t);
}

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
  const [qaNativeWebSearch, setQaNativeWebSearch] = useState(false);
  const [qaWebPasteContext, setQaWebPasteContext] = useState("");
  const activeStreamAbortRef = useRef<AbortController | null>(null);
  const stateLoadingAbortRef = useRef<AbortController | null>(null);
  const projectIdRef = useRef<number | null | undefined>(projectId);
  /** 仅「问答 + 勾选联网搜索」为 true，用于与「普通问答/自行摘录」分支隔离展示逻辑 */
  const lastQaNativeWebRef = useRef(false);

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
    setQaNativeWebSearch(readQaNativeWebSearchFromStorage());
  }, []);

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
    if (chatMode === "qa" && qaWebPasteContext.length > 16000) {
      setComposeError("自行检索摘录过长，请删减至 16000 字以内。");
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
      lastQaNativeWebRef.current =
        chatMode === "qa" && qaNativeWebSearch && !qaWebPasteContext.trim();
      streamAssistantId = `a-${Date.now()}`;
      const assistantPlaceholder =
        chatMode === "full_rewrite"
          ? "正在重写全文…"
          : chatMode === "partial_rewrite"
            ? "正在重写选区…"
            : chatMode === "search"
              ? "正在检索资料并生成回答…"
              : chatMode === "qa"
                ? "正在生成回答…"
                : "";
      setMessages((prev) => [
        ...prev,
        { id: streamAssistantId!, role: "assistant", content: assistantPlaceholder },
      ]);

      const selectionPayload = partialSelectionSnapshot
        ? { text: partialSelectionSnapshot.text, label: partialSelectionSnapshot.label }
        : undefined;

      const response = await fetch(
        getBackendSseUrl(`/api/projects/${requestProjectId}/chat/stream`),
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
            enable_native_web_search: chatMode === "qa" && qaNativeWebSearch,
            web_paste_context: chatMode === "qa" ? qaWebPasteContext.trim() : "",
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

      const handleSseBlock = (block: string) => {
        const dataLine = block
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.startsWith("data:"));
        if (!dataLine) {
          return;
        }
        const raw = dataLine.replace(/^data:\s*/, "");
        let event: ChatStreamEvent;
        try {
          event = JSON.parse(raw) as ChatStreamEvent;
        } catch {
          return;
        }

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
            return;
          }
          answer += event.content ?? "";
          if (chatMode !== "full_rewrite" && chatMode !== "partial_rewrite") {
            if (chatMode === "qa" && lastQaNativeWebRef.current) {
              // 仅方舟联网：整段返回后再解析，避免思考过程流式露出
              return;
            }
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
            return;
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
            let finalContent = `${answer}${sourceLine}`;
            if (chatMode === "qa" && lastQaNativeWebRef.current) {
              const display = extractQaAnswerForDisplay(answer);
              finalContent = (display || answer).trim() + sourceLine;
            }
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === streamAssistantId ? { ...msg, content: finalContent } : msg,
              ),
            );
            void persistMessage(requestProjectId, "assistant", finalContent);
          }
        }
      };

      const drainSseBuffer = () => {
        let boundary = sseBuffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = sseBuffer.slice(0, boundary);
          sseBuffer = sseBuffer.slice(boundary + 2);
          handleSseBlock(block);
          boundary = sseBuffer.indexOf("\n\n");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (value && value.byteLength > 0) {
          sseBuffer += decoder.decode(value, { stream: true });
        }
        drainSseBuffer();
        if (done) {
          sseBuffer += decoder.decode();
          drainSseBuffer();
          break;
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-700">
            <MessageSquare className="h-4 w-4 shrink-0" />
            AI 对话
          </div>
          {chatMode === "qa" ? (
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-zinc-600">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded border-zinc-300"
                checked={qaNativeWebSearch}
                disabled={asking || !!qaWebPasteContext.trim()}
                onChange={(e) => {
                  const v = e.target.checked;
                  setQaNativeWebSearch(v);
                  writeQaNativeWebSearchToStorage(v);
                }}
              />
              <span title="调用方舟 web_search 工具，需接入点支持联网">联网搜索</span>
            </label>
          ) : null}
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
        {chatMode === "qa" ? (
          <div className="mt-2 space-y-1">
            <p className="text-[10px] leading-snug text-zinc-500">
              自行检索摘录（可选）：粘贴网页要点后，将不走方舟联网工具、由模型仅根据摘录作答。
            </p>
            <textarea
              className="min-h-[52px] w-full resize-y rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-[11px] text-zinc-800 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300"
              placeholder="选填：自行搜索后粘贴摘要（与上方「联网搜索」二选一）"
              rows={2}
              maxLength={16000}
              disabled={asking}
              value={qaWebPasteContext}
              onChange={(e) => setQaWebPasteContext(e.target.value)}
            />
          </div>
        ) : null}
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
