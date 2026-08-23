/**
 * A small CommonMark subset, parsed to a block tree.
 *
 * Every LLM stage in this project writes markdown whether or not it was asked
 * to — a story bible comes back with `##` headings and `**bold**` labels, a
 * beat sheet as a numbered list — and the review UI rendered all of it as
 * `whitespace-pre-wrap` text, so the user read the punctuation instead of the
 * document. This is what turns that back into structure.
 *
 * Written here rather than pulled in, and this is the reason: the output is a
 * *tree*, not an HTML string. Every renderer in this repo builds React
 * elements from it, so there is no path by which model-authored text reaches
 * `dangerouslySetInnerHTML`. A markdown-to-HTML dependency would have to be
 * paired with a sanitiser to make the same guarantee, which is two
 * dependencies to avoid writing ~200 lines.
 *
 * The subset is what the stages actually emit: ATX headings, fenced code,
 * blockquotes, ordered/bullet lists (nested), thematic breaks, pipe tables,
 * and inline emphasis/code/links. Setext headings, reference links, raw HTML
 * and footnotes are deliberately absent — nothing generates them, and
 * unparsed markup degrades to its literal text rather than disappearing.
 */

export type Inline =
  | { type: "text"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string | null; value: string }
  | { type: "blockquote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "table"; header: Inline[][]; rows: Inline[][][] }
  | { type: "hr" };

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(?:```|~~~)\s*([\w+-]*)\s*$/;
const HR = /^(?:\s*(?:-\s*){3,}|\s*(?:\*\s*){3,}|\s*(?:_\s*){3,})$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.trim() === "") {
      index++;
      continue;
    }

    // Fenced code first: everything inside it is literal, including lines that
    // would otherwise look like headings or list items.
    const fence = FENCE.exec(line.trim());
    if (fence) {
      const lang = fence[1] || null;
      const body: string[] = [];
      index++;
      while (index < lines.length && !FENCE.test(lines[index]!.trim())) {
        body.push(lines[index]!);
        index++;
      }
      index++; // closing fence, or end of input
      blocks.push({ type: "code", lang, value: body.join("\n") });
      continue;
    }

    if (HR.test(line) && line.trim().length >= 3) {
      blocks.push({ type: "hr" });
      index++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        // Closing hashes ("## Title ##") are decoration, not content.
        children: parseInline(heading[2]!.replace(/\s+#+\s*$/, "")),
      });
      index++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && (QUOTE.test(lines[index]!) || lines[index]!.trim() !== "")) {
        const match = QUOTE.exec(lines[index]!);
        if (!match && lines[index]!.trim() === "") break;
        // A quote continues onto an unmarked line (lazy continuation).
        body.push(match ? match[1]! : lines[index]!);
        index++;
      }
      blocks.push({ type: "blockquote", children: parseBlocks(body) });
      continue;
    }

    const table = tryTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const list = parseList(lines, index);
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    // Paragraph: runs until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() !== "" && !startsBlock(lines[index]!)) {
      paragraph.push(lines[index]!.trim());
      index++;
    }
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    } else {
      // `startsBlock` matched on the first line but no branch above claimed it
      // — impossible today, but a guard against an infinite loop if a future
      // branch is added to one list and not the other.
      index++;
    }
  }

  return blocks;
}

function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    FENCE.test(line.trim()) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    (HR.test(line) && line.trim().length >= 3)
  );
}

/**
 * One list, and everything nested inside it.
 *
 * Items are collected by indentation: a line indented past the marker column
 * belongs to the item above, and is re-parsed (dedented) as that item's own
 * blocks. That is what makes a sub-list under a beat render as a sub-list
 * rather than as a paragraph starting with a hyphen.
 */
function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = ORDERED.exec(lines[start]!) ?? BULLET.exec(lines[start]!);
  const ordered = ORDERED.test(lines[start]!);
  const baseIndent = first![1]!.length;
  const startNumber = ordered ? Number(first![2]) : 1;

  const items: Block[][] = [];
  let current: string[] | null = null;
  let index = start;

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.trim() === "") {
      // A blank line ends the list only if the next line is not still part of
      // it — a loose list has blank lines between its own items.
      const next = lines[index + 1];
      if (next === undefined || (next.trim() !== "" && indentOf(next) < baseIndent + 1 && !isItem(next, baseIndent))) {
        break;
      }
      current?.push("");
      index++;
      continue;
    }

    const marker = matchItem(line, baseIndent);
    if (marker && marker.ordered === ordered) {
      if (current) items.push(parseBlocks(current));
      current = [marker.content];
      index++;
      continue;
    }

    // Not a new item at this level: either continuation of the current one, or
    // the end of the list.
    if (current && indentOf(line) > baseIndent) {
      current.push(line.slice(Math.min(indentOf(line), baseIndent + 2)));
      index++;
      continue;
    }
    if (current && !startsBlock(line)) {
      current.push(line.trim());
      index++;
      continue;
    }
    break;
  }

  if (current) items.push(parseBlocks(current));
  return { block: { type: "list", ordered, start: startNumber, items }, next: index };
}

function matchItem(line: string, baseIndent: number): { ordered: boolean; content: string } | null {
  const bullet = BULLET.exec(line);
  if (bullet && bullet[1]!.length <= baseIndent + 1) {
    return { ordered: false, content: bullet[3]! };
  }
  const ordered = ORDERED.exec(line);
  if (ordered && ordered[1]!.length <= baseIndent + 1) {
    return { ordered: true, content: ordered[3]! };
  }
  return null;
}

function isItem(line: string, baseIndent: number): boolean {
  return matchItem(line, baseIndent) !== null;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** A pipe table, which needs its divider row present to be one at all. */
function tryTable(lines: string[], start: number): { block: Block; next: number } | null {
  const header = lines[start]!;
  const divider = lines[start + 1];
  if (!header.includes("|") || divider === undefined || !TABLE_DIVIDER.test(divider)) return null;
  if (!divider.includes("-")) return null;

  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => parseInline(cell.trim()));

  const rows: Inline[][][] = [];
  let index = start + 2;
  while (index < lines.length && lines[index]!.trim() !== "" && lines[index]!.includes("|")) {
    rows.push(cells(lines[index]!));
    index++;
  }

  return { block: { type: "table", header: cells(header), rows }, next: index };
}

// Inline parsing. Order matters: code spans are taken first so that a `*` or
// `_` inside one is never read as emphasis.
const INLINE_PATTERNS: {
  regex: RegExp;
  build: (match: RegExpExecArray) => Inline;
}[] = [
  { regex: /`([^`]+)`/, build: (m) => ({ type: "code", value: m[1]! }) },
  {
    regex: /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
    build: (m) => ({ type: "link", href: m[2]!, children: parseInline(m[1]!) }),
  },
  { regex: /\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*/, build: (m) => ({ type: "strong", children: parseInline(m[1]!) }) },
  { regex: /__([^_]+)__/, build: (m) => ({ type: "strong", children: parseInline(m[1]!) }) },
  { regex: /\*([^*\n]+)\*/, build: (m) => ({ type: "em", children: parseInline(m[1]!) }) },
  // Intraword underscores ("shot_list", "scene_id") are not emphasis — a rule
  // CommonMark has and a naive parser does not, and this codebase's own text
  // is full of snake_case identifiers that would otherwise go italic.
  { regex: /(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/, build: (m) => ({ type: "em", children: parseInline(m[1]!) }) },
];

export function parseInline(source: string): Inline[] {
  if (source === "") return [];

  let earliest: { index: number; match: RegExpExecArray; build: (m: RegExpExecArray) => Inline } | null = null;
  for (const { regex, build } of INLINE_PATTERNS) {
    const match = regex.exec(source);
    if (match && (earliest === null || match.index < earliest.index)) {
      earliest = { index: match.index, match, build };
    }
  }

  if (!earliest) return [{ type: "text", value: source }];

  const { index, match, build } = earliest;
  const before = source.slice(0, index);
  const after = source.slice(index + match[0]!.length);

  return [
    ...(before ? [{ type: "text" as const, value: before }] : []),
    build(match),
    ...parseInline(after),
  ];
}

/**
 * Whether a string is worth rendering as markdown at all.
 *
 * The screenplay stages are told explicitly to emit no markdown (see
 * `defaults.ts`), and their output is whitespace-significant — running it
 * through a renderer that collapses blank lines and reflows paragraphs would
 * destroy the one thing a screenplay's layout carries. So the review surface
 * asks first, and falls back to preformatted text for anything that has no
 * markdown in it.
 */
export function looksLikeMarkdown(source: string): boolean {
  return /^(#{1,6}\s|\s*[-*+]\s|\s*\d{1,9}[.)]\s|>\s|```|\|.*\|)/m.test(source) || /\*\*[^*]+\*\*/.test(source);
}

/** Every inline node's text, concatenated — for titles, alt text and tests. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => (node.type === "text" || node.type === "code" ? node.value : inlineText(node.children)))
    .join("");
}
