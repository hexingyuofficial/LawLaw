"use client";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

export function SourceSheet() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">打开溯源面板</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>溯源面板</SheetTitle>
          <SheetDescription>原始证据文件预览区（占位）</SheetDescription>
        </SheetHeader>
        <div className="mt-4 flex h-[calc(100%-4rem)] items-center justify-center rounded-lg border border-dashed bg-zinc-50 text-zinc-500">
          原始证据文件预览区
        </div>
      </SheetContent>
    </Sheet>
  );
}
