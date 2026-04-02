import type { PartialBlock } from "@blocknote/core";

import { findTrailingSourceColumnIndex } from "@/lib/strip-markdown-table-source-column";

function inlineContentToPlain(content: unknown): string {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content.replace(/\u200B/g, "");
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (typeof item === "string") {
        return item.replace(/\u200B/g, "");
      }
      if (item && typeof item === "object" && "type" in item) {
        const ty = (item as { type: string }).type;
        if (ty === "docCitation") {
          const p = (item as { props?: { sourceFile?: string } }).props;
          return `[doc:${(p?.sourceFile ?? "").trim()}]`;
        }
        if (ty === "text") {
          return String((item as { text?: string }).text ?? "").replace(/\u200B/g, "");
        }
      }
      return "";
    })
    .join("");
}

/** 表格单元格内 BlockNote 块 → 纯文本（用于读表头、来源列） */
function blockToPlainText(block: PartialBlock): string {
  const b = block as Record<string, unknown>;
  const t = b.type as string;
  if (t === "paragraph" || t === "heading") {
    return inlineContentToPlain(b.content);
  }
  if (
    t === "bulletListItem" ||
    t === "numberedListItem" ||
    t === "checkListItem" ||
    t === "toggleListItem" ||
    t === "quote"
  ) {
    const children = b.children as PartialBlock[] | undefined;
    return (children ?? []).map((ch) => blockToPlainText(ch)).join("\n");
  }
  if (Array.isArray(b.children)) {
    return (b.children as PartialBlock[]).map((ch) => blockToPlainText(ch)).join("\n");
  }
  return "";
}

function cellToPlainText(cell: { content?: PartialBlock[] }): string {
  const inner = cell.content ?? [];
  return inner.map((blk) => blockToPlainText(blk)).join("\n").trim();
}

type TableCell = { content?: PartialBlock[]; colspan?: number; rowspan?: number };
type TableRow = { cells?: TableCell[] };

function tryStripTableBlock(block: PartialBlock): PartialBlock[] | null {
  const b = block as Record<string, unknown>;
  if (b.type !== "table" || !b.content || typeof b.content !== "object") {
    return null;
  }
  const content = b.content as { type?: string; rows?: TableRow[] };
  if (!Array.isArray(content.rows) || content.rows.length < 2) {
    return null;
  }
  const rows = content.rows;
  const headerCells = rows[0]?.cells ?? [];
  const colCount = headerCells.length;
  if (colCount < 2) {
    return null;
  }

  const headerTexts = headerCells.map((c) => cellToPlainText(c));
  const srcIdx = findTrailingSourceColumnIndex(headerTexts);
  if (srcIdx === -1) {
    return null;
  }

  for (let r = 0; r < rows.length; r++) {
    const n = rows[r]?.cells?.length ?? 0;
    if (n !== colCount) {
      return null;
    }
    for (const cell of rows[r]!.cells ?? []) {
      if ((cell.colspan ?? 1) > 1 || (cell.rowspan ?? 1) > 1) {
        return null;
      }
    }
  }

  const copy = JSON.parse(JSON.stringify(block)) as PartialBlock;
  const c = (copy as Record<string, unknown>).content as typeof content;
  const newRows = c.rows!.map((row) => {
    const cells = [...(row.cells ?? [])];
    return {
      ...row,
      cells: cells.filter((_, j) => j !== srcIdx),
    };
  });
  c.rows = newRows;

  const footnotes: string[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cell = rows[r]?.cells?.[srcIdx];
    const txt = cell ? cellToPlainText(cell) : "";
    if (txt.trim()) {
      footnotes.push(txt.trim());
    }
  }

  const tail: PartialBlock[] = footnotes.map((fn) => ({
    type: "paragraph",
    content: fn || "\u200B",
  }));

  return [copy, ...tail];
}

/**
 * BlockNote 文档里结构化 table 块不走 GFM `|` 行时，Markdown 文本剥离无效；在块上直接去掉末列「来源」并把内容挪到表后段落。
 */
export function stripSourceColumnFromTableBlocks(blocks: PartialBlock[]): PartialBlock[] {
  return blocks.flatMap((block) => {
    const b = block as Record<string, unknown>;
    if (b.type === "table") {
      const stripped = tryStripTableBlock(block);
      if (stripped) {
        return stripped;
      }
    }
    if (Array.isArray(b.children) && (b.children as PartialBlock[]).length > 0) {
      const newKids = stripSourceColumnFromTableBlocks(b.children as PartialBlock[]);
      return [{ ...b, children: newKids } as PartialBlock];
    }
    return [block];
  });
}
