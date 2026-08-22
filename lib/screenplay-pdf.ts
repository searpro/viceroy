import PDFDocument from "pdfkit";
import type { Script, Token } from "fountain-js";

/**
 * Typeset an approved screenplay's parsed Fountain tokens into a PDF.
 *
 * Deliberately not pixel-perfect WGA formatting — the bar this PR sets (per
 * the M7 detail page) is "recognizably correctly formatted, opens cleanly in
 * a normal PDF viewer", not exact industry typesetting. Standard-ish
 * conventions only: 12pt Courier throughout, 1.5in left / 1in right/top/
 * bottom margins, capitalized sluglines, indented/capitalized character
 * cues, indented parentheticals and dialogue, left-aligned action, and a
 * one-page title card in front of the script itself.
 */

const PAGE_MARGINS = { top: 72, bottom: 72, left: 108, right: 72 } as const; // 1in / 1in / 1.5in / 1in
const FONT_SIZE = 12;
const LINE_GAP = 2;

// Indents are relative to the left margin — pdfkit's `indent` option adds to
// it rather than replacing it, so these read as "how far past action text",
// which is what a screenwriting-format reference actually specifies.
const CHARACTER_INDENT = 180;
const PARENTHETICAL_INDENT = 140;
const DIALOGUE_INDENT = 100;
const DIALOGUE_WIDTH = 260;

export type ScreenplayPdfMeta = {
  title: string;
  idea: string;
};

/** Renders a parsed Fountain script to a PDF buffer, title page first. */
export function renderScreenplayPdf(script: Script, meta: ScreenplayPdfMeta): Promise<Buffer> {
  const doc = new PDFDocument({ margins: PAGE_MARGINS, size: "LETTER", autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.font("Courier").fontSize(FONT_SIZE);

  addTitlePage(doc, script, meta);
  addScript(doc, script.tokens ?? []);

  doc.end();
  return done;
}

function addTitlePage(doc: PDFKit.PDFDocument, script: Script, meta: ScreenplayPdfMeta): void {
  doc.addPage();
  const title = (script.title || meta.title || meta.idea).toUpperCase();

  doc.moveDown(8);
  doc.font("Courier-Bold").fontSize(16).text(title, { align: "center" });
  doc.font("Courier").fontSize(FONT_SIZE).moveDown(2);
  doc.text(meta.idea, { align: "center" });
}

function addScript(doc: PDFKit.PDFDocument, tokens: Token[]): void {
  doc.addPage();

  for (const token of tokens) {
    switch (token.type) {
      case "scene_heading":
        doc.moveDown(1).text((token.text ?? "").toUpperCase(), {
          indent: 0,
          lineGap: LINE_GAP,
        });
        break;
      case "action":
        doc.moveDown(1).text(token.text ?? "", { indent: 0, lineGap: LINE_GAP });
        break;
      case "character":
        doc.moveDown(1).text((token.text ?? "").toUpperCase(), {
          indent: CHARACTER_INDENT,
          lineGap: LINE_GAP,
        });
        break;
      case "parenthetical":
        doc.text(token.text ?? "", { indent: PARENTHETICAL_INDENT, lineGap: LINE_GAP });
        break;
      case "dialogue":
        doc.text(token.text ?? "", {
          indent: DIALOGUE_INDENT,
          width: DIALOGUE_WIDTH,
          lineGap: LINE_GAP,
        });
        break;
      case "transition":
        doc.moveDown(1).text((token.text ?? "").toUpperCase(), { align: "right", lineGap: LINE_GAP });
        break;
      // dialogue_begin/end, dual_dialogue_*, and every other structural token
      // (page_break, spaces, section, synopsis, note...) carry no text of
      // their own to lay out — Fountain's screenplay-stage generation never
      // produces most of these anyway (the prompt disallows sections/notes),
      // so skipping them silently is correct, not merely convenient.
      default:
        break;
    }
  }
}
