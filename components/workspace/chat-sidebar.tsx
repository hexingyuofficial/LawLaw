"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquare, SendHorizonal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilePoolSidebar } from "@/components/workspace/file-pool-sidebar";
import { readArkSettingsFromStorage } from "@/lib/ark-settings";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type RagStreamEvent =
  | { type: "sources"; sources: string[] }
  | { type: "delta"; content: string }
  | { type: "done"; sources?: string[] }
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

type ChatSidebarProps = {
  projectId?: number | null;
  documentText?: string;
};

export function ChatSidebar({ projectId, documentText = "" }: ChatSidebarProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [loadingState, setLoadingState] = useState(false);
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
    const text = input.trim();
    if (!text) {
      return;
    }
    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    if (!projectId) {
      setMessages((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: "assistant", content: "请先在左侧选择或创建项目。"},
      ]);
      return;
    }

    const ark = readArkSettingsFromStorage();
    if (!ark.api_key) {
      setMessages((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: "assistant", content: "请先在左侧齿轮中配置 API Key。"},
      ]);
      return;
    }

    setAsking(true);
    try {
      const requestProjectId = projectId;
      if (!requestProjectId) {
        return;
      }
      void persistMessage(requestProjectId, "user", text);

      const streamController = new AbortController();
      activeStreamAbortRef.current = streamController;
      const assistantId = `a-${Date.now()}`;
      setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "" }]);

      const response = await fetch(getBackendApiUrl("/api/rag-query/stream"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: streamController.signal,
        body: JSON.stringify({
          project_id: requestProjectId,
          api_key: ark.api_key,
          chat_vision_endpoint_id: ark.chat_vision_endpoint_id,
          embedding_endpoint_id: ark.embedding_endpoint_id,
          query: text,
          top_k: 6,
        }),
      });
      if (!response.ok) {
        let detail = `RAG 查询失败（${response.status}）`;
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
            const event = JSON.parse(raw) as RagStreamEvent;

            if (event.type === "sources") {
              sources = event.sources ?? [];
            } else if (event.type === "delta") {
              if (projectIdRef.current !== requestProjectId) {
                streamController.abort();
                break;
              }
              answer += event.content ?? "";
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantId ? { ...msg, content: answer } : msg,
                ),
              );
            } else if (event.type === "error") {
              throw new Error(event.message || "RAG 流式查询失败");
            } else if (event.type === "done") {
              if (projectIdRef.current !== requestProjectId) {
                streamController.abort();
                break;
              }
              const finalSources = event.sources?.length ? event.sources : sources;
              const sourceLine =
                finalSources.length > 0
                  ? `\n\n来源：${finalSources.map((s) => `[doc:${s}]`).join(" ")}`
                  : "";
              const finalContent = `${answer}${sourceLine}`;
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantId ? { ...msg, content: finalContent } : msg,
                ),
              );
              void persistMessage(requestProjectId, "assistant", finalContent);
            }
          }
          boundary = sseBuffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: error instanceof Error ? error.message : "RAG 查询失败，请稍后重试。",
        },
      ]);
    } finally {
      activeStreamAbortRef.current = null;
      setAsking(false);
    }
  };

  return (
    <aside className="flex h-full w-[360px] flex-col border-r bg-white">
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-700">
          <MessageSquare className="h-4 w-4" />
          AI 对话
        </div>
      </div>

      <div className="h-[48%] min-h-[320px] overflow-auto border-b">
        <FilePoolSidebar projectId={projectId} documentText={documentText} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3">
          {loadingState ? (
            <div className="rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-600">
              正在加载当前项目对话...
            </div>
          ) : null}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`rounded-lg px-3 py-2 text-sm ${
                msg.role === "assistant"
                  ? "bg-zinc-100 text-zinc-700"
                  : "bg-zinc-900 text-zinc-100"
              }`}
            >
              {msg.content}
            </div>
          ))}
        </div>
        <div className="border-t p-3">
          <div className="flex gap-2">
            <Input
              placeholder="输入问题，基于当前项目资料对话..."
              value={input}
              disabled={asking}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <Button size="icon" onClick={() => void sendMessage()} disabled={asking}>
              <SendHorizonal className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
}
