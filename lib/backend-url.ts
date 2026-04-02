/**
 * 浏览器端默认使用同源 `/api/...`，由 Next.js rewrites 转发到 FastAPI，避免直连错端口或服务导致的 404。
 * 生产可设置 NEXT_PUBLIC_BACKEND_URL（如 https://api.example.com）直连后端。
 */
export function getBackendApiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, "");
  if (base) {
    return `${base}${normalized}`;
  }
  if (typeof window !== "undefined") {
    return normalized;
  }
  return `http://127.0.0.1:8000${normalized}`;
}

/**
 * SSE（text/event-stream）不要用 Next.js rewrites：开发环境下代理常会整段缓冲，导致问答/检索长时间无输出。
 * - 已配置 NEXT_PUBLIC_BACKEND_URL 时用该地址；
 * - 本地 localhost/127.0.0.1 且未配置时直连 8000（与 uvicorn 默认一致）；
 * - 其它部署仍走同源 `/api`（需在网关关闭缓冲或配置 BACKEND_INTERNAL_URL 等）。
 */
export function getBackendSseUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, "");
  if (base) {
    return `${base}${normalized}`;
  }
  if (typeof window !== "undefined") {
    const h = window.location.hostname;
    if (h === "localhost" || h === "127.0.0.1") {
      return `http://127.0.0.1:8000${normalized}`;
    }
  }
  return normalized;
}
