import type { FileItem } from "@/lib/mock-data";

/** 与证据池、正文 [doc:…] 匹配时用的规范化（忽略大小写与空白差异） */
export function normalizeEvidenceKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

/**
 * 根据正文里 docCitation / [doc:文件名] 的 sourceFile，在证据列表中找对应条目。
 */
export function findFileItemByDocSourceFile(files: FileItem[], sourceFile: string): FileItem | null {
  const needle = (sourceFile || "").trim();
  if (!needle) {
    return null;
  }
  const normNeedle = normalizeEvidenceKey(needle);
  const stemNeedle = normalizeEvidenceKey(needle.replace(/\.[^.]+$/, ""));

  for (const f of files) {
    if (normalizeEvidenceKey(f.name) === normNeedle) {
      return f;
    }
  }
  for (const f of files) {
    const n = normalizeEvidenceKey(f.name);
    if (normNeedle.includes(n) || n.includes(normNeedle)) {
      return f;
    }
  }
  if (stemNeedle.length > 1) {
    for (const f of files) {
      const fs = normalizeEvidenceKey(f.name.replace(/\.[^.]+$/, ""));
      if (fs === stemNeedle || normNeedle.includes(fs) || fs.includes(stemNeedle)) {
        return f;
      }
    }
  }
  return null;
}
