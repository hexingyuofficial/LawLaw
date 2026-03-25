/**
 * 将模型常生成的「来源」列表格列去掉，把该列内容挪到表后独立段落，
 * 以便 [doc:…] 仍被 injectDocCitations 变成可点击药丸。
 * 不处理代码围栏内的内容。
 */

function parseTableRow(line: string): string[] | null {
  const t = line.trimEnd();
  const s = t.trimStart();
  if (!s.startsWith("|")) {
    return null;
  }
  const trimmed = t.trim();
  if (!trimmed.endsWith("|")) {
    return null;
  }
  const inner = trimmed.slice(1, -1);
  return inner.split("|").map((c) => c.trim());
}

function isTableRowLine(line: string): boolean {
  return parseTableRow(line) !== null;
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

/** 与表头比对：仅当列标题就是「来源 / 出处 / 依据」时才剥离，避免误伤「审理依据」等 */
function findSourceOnlyColumnIndex(headerCells: string[]): number {
  return headerCells.findIndex((c) => {
    const n = c.replace(/\*+/g, "").replace(/`/g, "").replace(/\s+/g, "");
    return n === "来源" || n === "出处" || n === "依据";
  });
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
  if (!header || !sep || !isSeparatorCells(sep)) {
    return { lines: tableLines, footnotes: [] };
  }
  const srcIdx = findSourceOnlyColumnIndex(header);
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
