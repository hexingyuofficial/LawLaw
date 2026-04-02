/**
 * 将模型常生成的「来源」列表格列去掉，把该列内容挪到表后独立段落，
 * 以便 [doc:…] 仍被 injectDocCitations 变成可点击药丸。
 * 不处理代码围栏内的内容。
 */

/** 表头单元格规范化：去格式、零宽字符、常见全角空白 */
function normalizeHeaderLabel(cell: string): string {
  return cell
    .replace(/\u200B|\uFEFF/g, "")
    .replace(/\*+/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, "")
    .replace(/\u3000/g, "");
}

/**
 * 拆 GFM 表格行。兼容行末无 `|`（BlockNote / 部分模型导出），否则整表无法进入处理流程。
 */
function parseTableRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) {
    return null;
  }
  const core = t.endsWith("|") ? t.slice(1, -1) : t.slice(1);
  if (!core.trim()) {
    return null;
  }
  const cells = core.split("|").map((c) => c.trim());
  return cells.length > 0 ? cells : null;
}

function isTableRowLine(line: string): boolean {
  const c = parseTableRow(line);
  return c !== null && c.length >= 1;
}

function isSeparatorCells(cells: string[]): boolean {
  if (cells.length === 0) {
    return false;
  }
  return cells.every((c) => {
    const x = c.replace(/\s/g, "");
    return /^:?-{3,}:?$/.test(x);
  });
}

/** 仅剥离「最后一列」且标题为来源类，避免误伤中间列「审理依据」等（Markdown 与 BlockNote 表格块共用） */
export function findTrailingSourceColumnIndex(headerCells: string[]): number {
  if (headerCells.length === 0) {
    return -1;
  }
  const last = headerCells.length - 1;
  const n = normalizeHeaderLabel(headerCells[last] ?? "");
  if (
    n === "来源" ||
    n === "出处" ||
    n === "依据" ||
    n === "来源文件" ||
    n === "文件来源"
  ) {
    return last;
  }
  return -1;
}

function emitRow(cells: string[]): string {
  if (cells.length === 0) {
    return "| |";
  }
  return `| ${cells.join(" | ")} |`;
}

function processTableLines(tableLines: string[]): { lines: string[]; footnotes: string[] } {
  if (tableLines.length < 2) {
    return { lines: tableLines, footnotes: [] };
  }
  const header = parseTableRow(tableLines[0]);
  const sep = parseTableRow(tableLines[1]);
  if (
    !header ||
    !sep ||
    !isSeparatorCells(sep) ||
    sep.length !== header.length ||
    header.length < 2
  ) {
    return { lines: tableLines, footnotes: [] };
  }
  const srcIdx = findTrailingSourceColumnIndex(header);
  if (srcIdx === -1) {
    return { lines: tableLines, footnotes: [] };
  }

  const newHeader = header.filter((_, j) => j !== srcIdx);
  const newSep = sep.filter((_, j) => j !== srcIdx);
  const outLines = [emitRow(newHeader), emitRow(newSep)];
  const footnotes: string[] = [];

  for (let r = 2; r < tableLines.length; r++) {
    const cells = parseTableRow(tableLines[r]);
    if (!cells) {
      outLines.push(tableLines[r]);
      continue;
    }
    const removed = (srcIdx < cells.length ? cells[srcIdx] : "").trim();
    if (removed) {
      footnotes.push(removed);
    }
    const padded = [...cells];
    while (padded.length < header.length) {
      padded.push("");
    }
    const trimmed = padded.slice(0, header.length);
    const dataRow = trimmed.filter((_, j) => j !== srcIdx);
    outLines.push(emitRow(dataRow));
  }

  return { lines: outLines, footnotes };
}

export function stripSourceColumnFromMarkdownTables(md: string): string {
  const text = (md ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const fence = line.trim().startsWith("```");
    if (fence) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }

    if (!isTableRowLine(line)) {
      out.push(line);
      i++;
      continue;
    }

    const block: string[] = [];
    while (i < lines.length && isTableRowLine(lines[i])) {
      block.push(lines[i]);
      i++;
    }
    const { lines: newTable, footnotes } = processTableLines(block);
    for (const nl of newTable) {
      out.push(nl);
    }
    for (const fn of footnotes) {
      out.push("");
      out.push(fn);
    }
  }

  return out.join("\n");
}
