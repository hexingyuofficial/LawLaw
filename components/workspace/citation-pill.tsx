"use client";

import { useState } from "react";
import { FileText } from "lucide-react";

import { useOpenEvidenceFromPill } from "@/components/workspace/evidence-preview-bridge-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { extractDocCitations } from "@/lib/citation-parse";

type CitationPillProps = {
  /** 从该文本解析 [doc:…]；可与 displayText 分离 */
  sourceText: string;
  className?: string;
  title?: string;
};

export function CitationPill({ sourceText, className = "", title = "本段引用的文件" }: CitationPillProps) {
  const openEvidence = useOpenEvidenceFromPill();
  const names = extractDocCitations(sourceText);
  const [open, setOpen] = useState(false);

  if (names.length === 0) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-600 shadow-sm transition hover:bg-zinc-100 ${className}`}
        title={title}
      >
        <FileText className="h-3 w-3 shrink-0" />
        依据 {names.length}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>以下文件名来自正文中的 [doc:…] 标注，可与证据池对照。</DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-2 overflow-y-auto text-sm text-zinc-800">
            {names.map((name) => (
              <li
                key={name}
                className="flex items-center justify-between gap-2 rounded-md border border-zinc-100 bg-zinc-50 px-2 py-1.5"
              >
                <span className="min-w-0 break-all">{name}</span>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      openEvidence(name);
                      setOpen(false);
                    }}
                  >
                    预览
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => void navigator.clipboard.writeText(name)}
                  >
                    复制
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
