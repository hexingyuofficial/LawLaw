import type { PartialBlock } from "@blocknote/core";

const DOC_MARKER_RE = /\[doc\s*:\s*([^\]\n]+?)\s*\]/gi;

type PartialInline = string | Record<string, unknown>;

/**
 * 将字符串里的 [doc:…] 拆成 text + docCitation 内联片段（用于写入 PartialBlock）。
 */
export function splitDocMarkersInString(text: string): PartialInline[] {
  const t = text ?? "";
  const parts: PartialInline[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(DOC_MARKER_RE.source, DOC_MARKER_RE.flags);
  while ((m = re.exec(t)) !== null) {
    if (m.index > last) {
      parts.push(t.slice(last, m.index));
    }
    const file = (m[1] ?? "").trim();
    if (file) {
      parts.push({
        type: "docCitation",
        props: { sourceFile: file },
      });
    }
    last = m.index + m[0].length;
  }
  if (last < t.length) {
    parts.push(t.slice(last));
  }
  if (parts.length === 0) {
    return [t || "\u200B"];
  }
  if (parts.length === 1 && typeof parts[0] === "string") {
    return parts;
  }
  return parts;
}

function transformContentField(content: unknown): unknown {
  if (content == null) {
    return content;
  }
  if (typeof content === "string") {
    const split = splitDocMarkersInString(content);
    if (split.length === 1 && typeof split[0] === "string") {
      return split[0];
    }
    return split;
  }
  if (!Array.isArray(content)) {
    return content;
  }
  const out: PartialInline[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      const split = splitDocMarkersInString(item);
      for (const s of split) {
        out.push(s);
      }
      continue;
    }
    if (item && typeof item === "object" && "type" in item && (item as { type: string }).type === "text") {
      const rec = item as { type: "text"; text: string; styles?: unknown };
      const split = splitDocMarkersInString(String(rec.text ?? ""));
      for (const s of split) {
        if (typeof s === "string") {
          out.push({ ...rec, text: s });
        } else {
          out.push(s);
        }
      }
      continue;
    }
    if (item && typeof item === "object" && "type" in item && (item as { type: string }).type === "docCitation") {
      out.push(item as PartialInline);
      continue;
    }
    out.push(item as PartialInline);
  }
  return out;
}

function injectIntoBlock(block: PartialBlock): PartialBlock {
  const b = { ...block } as Record<string, unknown>;

  // 代码块等保持原文，避免把 [doc:] 示例代码拆成内联节点
  if (
    b.type === "codeBlock" ||
    b.type === "image" ||
    b.type === "video" ||
    b.type === "audio" ||
    b.type === "file"
  ) {
    return b as PartialBlock;
  }

  if (b.type === "table" && b.content && typeof b.content === "object") {
    const tc = b.content as {
      type?: string;
      rows?: Array<{ cells?: Array<{ content?: PartialBlock[] }> }>;
    };
    if (tc.type === "tableContent" && Array.isArray(tc.rows)) {
      b.content = {
        ...tc,
        rows: tc.rows.map((row) => ({
          ...row,
          cells: (row.cells ?? []).map((cell) => ({
            ...cell,
            content: Array.isArray(cell.content)
              ? injectDocCitationsIntoBlocks(cell.content as PartialBlock[])
              : cell.content,
          })),
        })),
      };
      return b as PartialBlock;
    }
  }

  if ("content" in b && b.content !== undefined) {
    b.content = transformContentField(b.content);
  }
  if (Array.isArray(b.children)) {
    b.children = injectDocCitationsIntoBlocks(b.children as PartialBlock[]);
  }
  return b as PartialBlock;
}

/** 递归处理段落、标题、列表、表格单元格等，把 [doc:…] 换成 docCitation 内联节点 */
export function injectDocCitationsIntoBlocks(blocks: PartialBlock[]): PartialBlock[] {
  return blocks.map((block) => injectIntoBlock(block));
}
