"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil, Plus, Settings, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  API_KEY_STORAGE,
  CHAT_VISION_ENDPOINT_STORAGE,
  EMBEDDING_ENDPOINT_STORAGE,
  migrateLegacyArkStorage,
} from "@/lib/ark-settings";

type Project = {
  id: number;
  name: string;
  created_at: string;
};

type ProjectSidebarProps = {
  selectedProjectId: number | null;
  onSelectProject: (projectId: number | null) => void;
  onProjectChange?: (projects: Project[]) => void;
};

function getBackendApiUrl(path: string) {
  if (typeof window === "undefined") {
    return `http://localhost:8000${path}`;
  }
  const isLoopbackHost =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const backendHost = isLoopbackHost ? window.location.hostname : "localhost";
  return `${window.location.protocol}//${backendHost}:8000${path}`;
}

function readableApiError(err: unknown, fallback: string) {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("failed to fetch") || msg.includes("load failed")) {
      return "无法连接后端服务，请确认 8000 端口后端已启动且依赖安装完整。";
    }
    return err.message;
  }
  return fallback;
}

export function ProjectSidebar({
  selectedProjectId,
  onSelectProject,
  onProjectChange,
}: ProjectSidebarProps) {
  const [apiKey, setApiKey] = useState("");
  const [chatEndpointId, setChatEndpointId] = useState("");
  const [embeddingEndpointId, setEmbeddingEndpointId] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState<number | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [apiDialogOpen, setApiDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [renameProjectName, setRenameProjectName] = useState("");
  const [renameProjectId, setRenameProjectId] = useState<number | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const [checkingModels, setCheckingModels] = useState(false);
  const [probeResult, setProbeResult] = useState("");
  const projectItemRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const loadProjects = async () => {
    try {
      setError("");
      const response = await fetch(getBackendApiUrl("/api/projects"));
      if (!response.ok) {
        throw new Error(`项目列表加载失败（${response.status}）`);
      }
      const list = (await response.json()) as Project[];
      setProjects(list);
      onProjectChange?.(list);
      if (list.length > 0 && !selectedProjectId) {
        onSelectProject(list[0].id);
      }
    } catch (err) {
      setError(readableApiError(err, "项目列表加载失败"));
    }
  };

  useEffect(() => {
    migrateLegacyArkStorage();
    setApiKey(window.localStorage.getItem(API_KEY_STORAGE) ?? "");
    setChatEndpointId(window.localStorage.getItem(CHAT_VISION_ENDPOINT_STORAGE) ?? "");
    setEmbeddingEndpointId(window.localStorage.getItem(EMBEDDING_ENDPOINT_STORAGE) ?? "");
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveApiKey = () => {
    try {
      const normalizedKey = apiKey.trim();
      const chatEp = chatEndpointId.trim();
      const embedEp = embeddingEndpointId.trim();
      window.localStorage.setItem(API_KEY_STORAGE, normalizedKey);
      window.localStorage.setItem(CHAT_VISION_ENDPOINT_STORAGE, chatEp);
      window.localStorage.setItem(EMBEDDING_ENDPOINT_STORAGE, embedEp);
      setApiKey(normalizedKey);
      setChatEndpointId(chatEp);
      setEmbeddingEndpointId(embedEp);
      setApiDialogOpen(false);
      showToast("方舟凭证与接入点已保存");
    } catch {
      setError("保存失败，请检查浏览器是否允许本地存储。");
    }
  };

  const showToast = (message: string) => {
    setToastMessage(message);
    window.setTimeout(() => {
      setToastMessage("");
    }, 1800);
  };

  const handleCreateProject = async () => {
    const name = newProjectName.trim();
    if (!name) {
      setError("项目名称不能为空");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const response = await fetch(getBackendApiUrl("/api/projects"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        throw new Error(`创建项目失败（${response.status}）`);
      }
      const created = (await response.json()) as Project;
      const next = [created, ...projects];
      setProjects(next);
      onProjectChange?.(next);
      onSelectProject(created.id);
      setCreateDialogOpen(false);
      setNewProjectName("");
      await loadProjects();
      window.requestAnimationFrame(() => {
        projectItemRefs.current[created.id]?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      });
      showToast("项目创建成功");
    } catch (err) {
      setError(readableApiError(err, "创建项目失败"));
    } finally {
      setCreating(false);
    }
  };

  const openRenameDialog = (project: Project) => {
    setRenameProjectId(project.id);
    setRenameProjectName(project.name);
    setRenameDialogOpen(true);
  };

  const handleRenameProject = async () => {
    const name = renameProjectName.trim();
    if (!name || !renameProjectId) {
      setError("项目名称不能为空");
      return;
    }
    setRenaming(true);
    setError("");
    try {
      const response = await fetch(getBackendApiUrl(`/api/projects/${renameProjectId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        throw new Error(`重命名失败（${response.status}）`);
      }
      const updated = (await response.json()) as Project;
      const next = projects.map((item) => (item.id === updated.id ? updated : item));
      setProjects(next);
      onProjectChange?.(next);
      setRenameDialogOpen(false);
      setRenameProjectId(null);
      setRenameProjectName("");
      await loadProjects();
      showToast("项目重命名成功");
    } catch (err) {
      setError(readableApiError(err, "重命名失败"));
    } finally {
      setRenaming(false);
    }
  };

  const handleDeleteProject = async (projectId: number) => {
    setDeletingProjectId(projectId);
    setError("");
    try {
      const response = await fetch(getBackendApiUrl(`/api/projects/${projectId}`), {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(`删除项目失败（${response.status}）`);
      }
      const next = projects.filter((item) => item.id !== projectId);
      setProjects(next);
      onProjectChange?.(next);
      if (selectedProjectId === projectId) {
        if (next.length > 0) {
          onSelectProject(next[0].id);
        } else {
          onSelectProject(null);
        }
      }
      showToast("项目已关闭");
    } catch (err) {
      setError(readableApiError(err, "删除项目失败"));
    } finally {
      setDeletingProjectId(null);
    }
  };

  const handleProbeModels = async () => {
    setCheckingModels(true);
    setProbeResult("");
    try {
      const response = await fetch(getBackendApiUrl("/api/model-probe"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey.trim(),
          chat_vision_endpoint_id: chatEndpointId.trim(),
          embedding_endpoint_id: embeddingEndpointId.trim(),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new Error(body.detail || `检测失败（${response.status}）`);
      }
      const data = (await response.json()) as {
        ok: boolean;
        embedding: { ok: boolean; error?: string };
        chat_vision: { ok: boolean; error?: string };
      };
      if (data.ok) {
        setProbeResult("检测通过：Embedding 与聊天模型均可用。");
      } else {
        const lines: string[] = [];
        lines.push(data.embedding.ok ? "Embedding: 可用" : `Embedding: ${data.embedding.error || "不可用"}`);
        lines.push(data.chat_vision.ok ? "Chat/Vision: 可用" : `Chat/Vision: ${data.chat_vision.error || "不可用"}`);
        setProbeResult(lines.join("\n"));
      }
    } catch (err) {
      setProbeResult(readableApiError(err, "检测失败，请稍后重试"));
    } finally {
      setCheckingModels(false);
    }
  };

  return (
    <aside className="flex h-full w-64 flex-col bg-zinc-950 text-zinc-100">
      <div className="p-4">
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button className="w-full justify-start gap-2 bg-zinc-100 text-zinc-900 hover:bg-zinc-200">
              <Plus className="h-4 w-4" />
              新增项目
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新增项目</DialogTitle>
              <DialogDescription>输入项目名称后创建，可后续继续重命名。</DialogDescription>
            </DialogHeader>
            <Input
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="请输入项目名称"
            />
            <DialogFooter>
              <Button onClick={handleCreateProject} disabled={creating}>
                {creating ? "创建中..." : "确认创建"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3">
        {projects.map((project) => (
          <div
            key={String(project.id)}
            ref={(el) => {
              projectItemRefs.current[project.id] = el;
            }}
            className={`w-full rounded-lg border px-3 py-2 text-left transition ${
              project.id === selectedProjectId
                ? "border-zinc-600 bg-zinc-800"
                : "border-transparent bg-zinc-900/60 hover:bg-zinc-800/70"
            }`}
          >
            <div className="mb-1 flex items-start justify-between gap-2">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelectProject(project.id)}>
                <p className="truncate text-sm font-medium">{project.name}</p>
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                onClick={() => void handleDeleteProject(project.id)}
                disabled={deletingProjectId === project.id}
                title="关闭项目"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            <button type="button" className="w-full text-left" onClick={() => onSelectProject(project.id)}>
              <p className="text-xs text-zinc-400">
                {new Date(project.created_at).toLocaleDateString("zh-CN")}
              </p>
            </button>
            <div className="mt-2 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
                onClick={() => openRenameDialog(project)}
              >
                <Pencil className="mr-1 h-3.5 w-3.5" />
                重命名
              </Button>
            </div>
          </div>
        ))}
        {error ? <p className="text-xs text-red-300">{error}</p> : null}
      </div>

      {toastMessage ? (
        <div className="pointer-events-none px-3 pb-2">
          <div className="rounded-md border border-emerald-700/50 bg-emerald-900/80 px-3 py-2 text-xs text-emerald-100">
            {toastMessage}
          </div>
        </div>
      ) : null}

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名项目</DialogTitle>
            <DialogDescription>修改后将立即保存到后端数据库。</DialogDescription>
          </DialogHeader>
          <Input
            value={renameProjectName}
            onChange={(e) => setRenameProjectName(e.target.value)}
            placeholder="请输入新的项目名称"
          />
          <DialogFooter>
            <Button onClick={handleRenameProject} disabled={renaming}>
              {renaming ? "保存中..." : "确认保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="shrink-0 border-t border-zinc-800 bg-zinc-950 p-3">
        <Dialog open={apiDialogOpen} onOpenChange={setApiDialogOpen}>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              className="w-full justify-start gap-2 border border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
            >
              <Settings className="h-4 w-4" />
              API 设置
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>方舟 API 设置</DialogTitle>
              <DialogDescription>
                填写火山方舟 API Key 与两个推理接入点 ID（ep- 开头）。将保存到本机 localStorage；请求时优先使用此处配置，未填项由后端读
                .env。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <p className="text-xs font-medium text-zinc-600">API Key</p>
                <Input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="ARK_API_KEY"
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-zinc-600">Chat / Vision 接入点 ID</p>
                <Input
                  value={chatEndpointId}
                  onChange={(e) => setChatEndpointId(e.target.value)}
                  placeholder="例如 ep-20260325021919-xxxx"
                />
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-zinc-600">Embedding 接入点 ID</p>
                <Input
                  value={embeddingEndpointId}
                  onChange={(e) => setEmbeddingEndpointId(e.target.value)}
                  placeholder="例如 ep-20260325022810-xxxx"
                />
              </div>
            </div>
            <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-zinc-600">使用上方三项调用后端探测接口</p>
                <Button variant="secondary" size="sm" onClick={handleProbeModels} disabled={checkingModels}>
                  {checkingModels ? "检测中..." : "检测模型可用性"}
                </Button>
              </div>
              {probeResult ? (
                <pre className="whitespace-pre-wrap text-xs text-zinc-700">{probeResult}</pre>
              ) : null}
            </div>
            <DialogFooter>
              <Button onClick={saveApiKey}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </aside>
  );
}
