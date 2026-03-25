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
