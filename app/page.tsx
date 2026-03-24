"use client";

import { useState } from "react";

import { ChatSidebar } from "@/components/workspace/chat-sidebar";
import { EditorPanel } from "@/components/workspace/editor-panel";
import { ProjectSidebar } from "@/components/workspace/project-sidebar";

export default function HomePage() {
  const [documentText, setDocumentText] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);

  return (
    <main className="h-screen w-screen overflow-x-auto overflow-y-hidden bg-zinc-100">
      <div className="flex h-full min-w-[1400px]">
        <ProjectSidebar
          selectedProjectId={selectedProjectId}
          onSelectProject={setSelectedProjectId}
        />
        <ChatSidebar projectId={selectedProjectId} documentText={documentText} />
        <EditorPanel
          onDocumentTextChange={setDocumentText}
          projectId={selectedProjectId}
        />
      </div>
    </main>
  );
}
