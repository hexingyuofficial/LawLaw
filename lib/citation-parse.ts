/**
 * 从正文里提取 [doc:文件名] 及「来源：」行中的 doc 引用，去重保序。
 */
const DOC_MARKER_RE = /\[doc\s*:\s*([^\]\n]+?)\s*\]/gi;

export function extractDocCitations(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const t = text || "";
  let m: RegExpExecArray | null;
  const re = new RegExp(DOC_MARKER_RE.source, DOC_MARKER_RE.flags);
  while ((m = re.exec(t)) !== null) {
    const name = (m[1] ?? "").trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * 展示助手消息时去掉末尾「来源：…[doc:…]」段落，改由药丸展示。
 */
export function stripTrailingSourcesBlock(text: string): string {
  const t = (text || "").trimEnd();
  const idx = t.search(/\n\n来源[：:]\s*/);
  if (idx === -1) {
    return text;
  }
  return t.slice(0, idx).trimEnd();
}

/**
 * 根据选中文本在全文 markdown 中定位大致行号范围（1-based），用于 label。
 */
export function selectionLineLabel(fullMarkdown: string, selection: string): string {
  const doc = fullMarkdown || "";
  const sel = (selection || "").trim();
  if (!sel || sel.length < 2) {
    return "选区";
  }
  const head = sel.slice(0, Math.min(80, sel.length));
  const i = doc.indexOf(head);
  if (i === -1) {
    return `选区约 ${sel.length} 字`;
  }
  const startLine = doc.slice(0, i).split("\n").length;
  const endOffset = i + sel.length;
  const endLine = doc.slice(0, endOffset).split("\n").length;
  if (startLine === endLine) {
    return `约第 ${startLine} 行`;
  }
  return `约第 ${startLine}–${endLine} 行`;
}
