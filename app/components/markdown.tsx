import { Fragment } from "react";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";

/**
 * Renders `lib/markdown.ts`'s block tree as React elements.
 *
 * No `dangerouslySetInnerHTML` anywhere in this file, deliberately: every node
 * here comes from model-authored text, and building elements from a tree means
 * there is no string of HTML for it to smuggle anything into. Link `href`s are
 * the one attribute a document controls, so they are filtered to http(s) —
 * `javascript:` is the one scheme that would otherwise still be live.
 *
 * Paragraphs use `whitespace-pre-line`. The stages emit soft line breaks that
 * carry meaning — a screenplay's character/parenthetical/dialogue stack is
 * three lines of one paragraph — and reflowing them the way a strict
 * CommonMark renderer does would flatten the one thing that layout says.
 */
export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  return <div className={`space-y-3 text-sm leading-relaxed ${className}`}>{blocks(parseMarkdown(source))}</div>;
}

function blocks(list: Block[]): React.ReactNode {
  return list.map((block, index) => <Fragment key={index}>{renderBlock(block)}</Fragment>);
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-base font-semibold text-white/90",
  2: "text-sm font-semibold text-white/90",
  3: "text-sm font-medium text-white/85",
  4: "text-xs font-medium uppercase tracking-wide text-white/50",
  5: "text-xs font-medium uppercase tracking-wide text-white/45",
  6: "text-xs font-medium uppercase tracking-wide text-white/40",
};

function renderBlock(block: Block): React.ReactNode {
  switch (block.type) {
    case "heading": {
      const Tag = `h${Math.min(block.level + 2, 6)}` as "h3";
      return (
        <Tag className={`${HEADING_CLASS[block.level] ?? HEADING_CLASS[3]} ${block.level <= 2 ? "mt-5 first:mt-0" : "mt-4 first:mt-0"}`}>
          {inlines(block.children)}
        </Tag>
      );
    }
    case "paragraph":
      return <p className="whitespace-pre-line text-white/75">{inlines(block.children)}</p>;
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-white/75">
          <code>{block.value}</code>
        </pre>
      );
    case "blockquote":
      return (
        <blockquote className="space-y-3 border-l-2 border-white/15 pl-3 text-white/60">
          {blocks(block.children)}
        </blockquote>
      );
    case "list": {
      const className = "space-y-1.5 pl-5 text-white/75 " + (block.ordered ? "list-decimal" : "list-disc");
      const items = block.items.map((item, index) => (
        <li key={index} className="space-y-2 pl-1 marker:text-white/35">
          {blocks(item)}
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start} className={className}>
          {items}
        </ol>
      ) : (
        <ul className={className}>{items}</ul>
      );
    }
    case "table":
      return (
        // Its own scroll container: a wide breakdown table must not make the
        // whole page scroll sideways.
        <div className="overflow-x-auto">
          <table className="w-full min-w-[24rem] border-collapse text-xs">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th
                    key={index}
                    className="border-b border-white/15 px-2 py-1.5 text-left font-medium text-white/60"
                  >
                    {inlines(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="border-b border-white/5 px-2 py-1.5 align-top text-white/75">
                      {inlines(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr className="border-white/10" />;
  }
}

function inlines(nodes: Inline[]): React.ReactNode {
  return nodes.map((node, index) => <Fragment key={index}>{renderInline(node)}</Fragment>);
}

function renderInline(node: Inline): React.ReactNode {
  switch (node.type) {
    case "text":
      return node.value;
    case "strong":
      return <strong className="font-semibold text-white/90">{inlines(node.children)}</strong>;
    case "em":
      return <em className="italic text-white/70">{inlines(node.children)}</em>;
    case "code":
      return (
        <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.9em] text-amber-200/90">
          {node.value}
        </code>
      );
    case "link": {
      // Anything that isn't plainly http(s) renders as its own text rather
      // than as a live link — see the file comment.
      const safe = /^https?:\/\//i.test(node.href);
      if (!safe) return inlines(node.children);
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-amber-300 underline decoration-amber-300/40 underline-offset-2 hover:text-amber-200"
        >
          {inlines(node.children)}
        </a>
      );
    }
  }
}
