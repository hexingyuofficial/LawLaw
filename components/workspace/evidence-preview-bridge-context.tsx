"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

type OpenBySourceFileHandler = (sourceFile: string) => void;

type EvidencePreviewBridgeContextValue = {
  /** 由证据与资料侧栏注册，实现「按文件名打开预览」 */
  registerOpenBySourceFile: (handler: OpenBySourceFileHandler | null) => void;
  /** 正文内依据药丸等处调用 */
  openEvidenceFromPill: (sourceFile: string) => void;
};

const EvidencePreviewBridgeContext = createContext<EvidencePreviewBridgeContextValue | null>(null);

export function EvidencePreviewBridgeProvider({ children }: { children: ReactNode }) {
  const handlerRef = useRef<OpenBySourceFileHandler | null>(null);

  const registerOpenBySourceFile = useCallback((handler: OpenBySourceFileHandler | null) => {
    handlerRef.current = handler;
  }, []);

  const openEvidenceFromPill = useCallback((sourceFile: string) => {
    handlerRef.current?.(sourceFile);
  }, []);

  const value = useMemo(
    () => ({ registerOpenBySourceFile, openEvidenceFromPill }),
    [registerOpenBySourceFile, openEvidenceFromPill],
  );

  return (
    <EvidencePreviewBridgeContext.Provider value={value}>{children}</EvidencePreviewBridgeContext.Provider>
  );
}

export function useEvidencePreviewBridge() {
  const ctx = useContext(EvidencePreviewBridgeContext);
  if (!ctx) {
    throw new Error("EvidencePreviewBridgeProvider 缺失");
  }
  return ctx;
}

/** 未包裹 Provider 时安全降级为 no-op（例如单测） */
export function useOpenEvidenceFromPill() {
  const ctx = useContext(EvidencePreviewBridgeContext);
  return ctx?.openEvidenceFromPill ?? (() => {});
}
