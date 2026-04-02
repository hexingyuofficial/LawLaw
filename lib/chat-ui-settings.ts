/** 问答模式：是否启用方舟原生联网工具（localStorage） */
export const QA_NATIVE_WEB_SEARCH_STORAGE = "lawlaw_qa_native_web_search";

export function readQaNativeWebSearchFromStorage(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(QA_NATIVE_WEB_SEARCH_STORAGE) === "1";
  } catch {
    return false;
  }
}

export function writeQaNativeWebSearchToStorage(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (enabled) {
      window.localStorage.setItem(QA_NATIVE_WEB_SEARCH_STORAGE, "1");
    } else {
      window.localStorage.removeItem(QA_NATIVE_WEB_SEARCH_STORAGE);
    }
  } catch {
    // ignore
  }
}
