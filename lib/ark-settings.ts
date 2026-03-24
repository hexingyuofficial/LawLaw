export const API_KEY_STORAGE = "lawlaw_api_key";
export const CHAT_VISION_ENDPOINT_STORAGE = "lawlaw_chat_vision_endpoint_id";
export const EMBEDDING_ENDPOINT_STORAGE = "lawlaw_embedding_endpoint_id";

const LEGACY_CHAT = "lawlaw_chat_vision_model_id";
const LEGACY_EMBEDDING = "lawlaw_embedding_model_id";

/** 从旧版 localStorage 键迁移到 ep- 接入点专用键（仅当新键为空时）。 */
export function migrateLegacyArkStorage(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!localStorage.getItem(CHAT_VISION_ENDPOINT_STORAGE)?.trim()) {
      const v = localStorage.getItem(LEGACY_CHAT)?.trim();
      if (v) {
        localStorage.setItem(CHAT_VISION_ENDPOINT_STORAGE, v);
      }
    }
    if (!localStorage.getItem(EMBEDDING_ENDPOINT_STORAGE)?.trim()) {
      const v = localStorage.getItem(LEGACY_EMBEDDING)?.trim();
      if (v) {
        localStorage.setItem(EMBEDDING_ENDPOINT_STORAGE, v);
      }
    }
  } catch {
    // ignore quota / private mode
  }
}

export type ArkSettingsPayload = {
  api_key: string;
  chat_vision_endpoint_id: string;
  embedding_endpoint_id: string;
};

export function readArkSettingsFromStorage(): ArkSettingsPayload {
  migrateLegacyArkStorage();
  if (typeof window === "undefined") {
    return { api_key: "", chat_vision_endpoint_id: "", embedding_endpoint_id: "" };
  }
  return {
    api_key: window.localStorage.getItem(API_KEY_STORAGE)?.trim() ?? "",
    chat_vision_endpoint_id:
      window.localStorage.getItem(CHAT_VISION_ENDPOINT_STORAGE)?.trim() ?? "",
    embedding_endpoint_id:
      window.localStorage.getItem(EMBEDDING_ENDPOINT_STORAGE)?.trim() ?? "",
  };
}
