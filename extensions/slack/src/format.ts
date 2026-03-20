import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import {
  chunkMarkdownIR,
  markdownToIR,
  type MarkdownIR,
  type MarkdownLinkSpan,
  type MarkdownStyleSpan,
} from "openclaw/plugin-sdk/text-runtime";
import { renderMarkdownWithMarkers } from "openclaw/plugin-sdk/text-runtime";

// Escape special characters for Slack mrkdwn format.
// Preserve Slack's angle-bracket tokens so mentions and links stay intact.
function escapeSlackMrkdwnSegment(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SLACK_ANGLE_TOKEN_RE = /<[^>\n]+>/g;

function isAllowedSlackAngleToken(token: string): boolean {
  if (!token.startsWith("<") || !token.endsWith(">")) {
    return false;
  }
  const inner = token.slice(1, -1);
  return (
    inner.startsWith("@") ||
    inner.startsWith("#") ||
    inner.startsWith("!") ||
    inner.startsWith("mailto:") ||
    inner.startsWith("tel:") ||
    inner.startsWith("http://") ||
    inner.startsWith("https://") ||
    inner.startsWith("slack://")
  );
}

function escapeSlackMrkdwnContent(text: string): string {
  if (!text) {
    return "";
  }
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  SLACK_ANGLE_TOKEN_RE.lastIndex = 0;
  const out: string[] = [];
  let lastIndex = 0;

  for (
    let match = SLACK_ANGLE_TOKEN_RE.exec(text);
    match;
    match = SLACK_ANGLE_TOKEN_RE.exec(text)
  ) {
    const matchIndex = match.index ?? 0;
    out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex, matchIndex)));
    const token = match[0] ?? "";
    out.push(isAllowedSlackAngleToken(token) ? token : escapeSlackMrkdwnSegment(token));
    lastIndex = matchIndex + token.length;
  }

  out.push(escapeSlackMrkdwnSegment(text.slice(lastIndex)));
  return out.join("");
}

function escapeSlackMrkdwnText(text: string): string {
  if (!text) {
    return "";
  }
  if (!text.includes("&") && !text.includes("<") && !text.includes(">")) {
    return text;
  }

  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("> ")) {
        return `> ${escapeSlackMrkdwnContent(line.slice(2))}`;
      }
      return escapeSlackMrkdwnContent(line);
    })
    .join("\n");
}

function buildSlackLink(link: MarkdownLinkSpan, text: string) {
  const href = link.href.trim();
  if (!href) {
    return null;
  }
  const label = text.slice(link.start, link.end);
  const trimmedLabel = label.trim();
  const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
  const useMarkup =
    trimmedLabel.length > 0 && trimmedLabel !== href && trimmedLabel !== comparableHref;
  if (!useMarkup) {
    return null;
  }
  const safeHref = escapeSlackMrkdwnSegment(href);
  return {
    start: link.start,
    end: link.end,
    open: `<${safeHref}|`,
    close: ">",
  };
}

type SlackMarkdownOptions = {
  tableMode?: MarkdownTableMode;
};

const SLACK_LABEL_TERMINATOR_RE = /[.?!:]$/;
const SLACK_CONTINUATION_BLOCK_MARKER_RE = /^(?:• |\d+\. |> |```|───)/;

function buildSlackRenderOptions() {
  return {
    styleMarkers: {
      bold: { open: "*", close: "*" },
      italic: { open: "_", close: "_" },
      strikethrough: { open: "~", close: "~" },
      code: { open: "`", close: "`" },
      code_block: { open: "```\n", close: "```" },
    },
    escapeText: escapeSlackMrkdwnText,
    buildLink: buildSlackLink,
  };
}

function findLineEnd(text: string, start: number): number {
  const lineEnd = text.indexOf("\n", start);
  return lineEnd === -1 ? text.length : lineEnd;
}

function intersectsProtectedStyle(spans: MarkdownStyleSpan[], start: number, end: number): boolean {
  return spans.some((span) => span.start < end && span.end > start);
}

function isBoldLabelLine(
  text: string,
  styles: MarkdownStyleSpan[],
  lineStart: number,
  lineEnd: number,
): boolean {
  let labelStart = lineStart + 2;
  let labelEnd = lineEnd;

  while (labelStart < labelEnd && /\s/.test(text[labelStart] ?? "")) {
    labelStart += 1;
  }
  while (labelEnd > labelStart && /\s/.test(text[labelEnd - 1] ?? "")) {
    labelEnd -= 1;
  }
  if (labelStart >= labelEnd) {
    return false;
  }

  const label = text.slice(labelStart, labelEnd);
  if (SLACK_LABEL_TERMINATOR_RE.test(label)) {
    return false;
  }

  return styles.some(
    (span) => span.style === "bold" && span.start <= labelStart && span.end >= labelEnd,
  );
}

function isSlackContinuationLine(line: string): boolean {
  if (!line) {
    return false;
  }
  if (/^\s/.test(line)) {
    return false;
  }
  return !SLACK_CONTINUATION_BLOCK_MARKER_RE.test(line);
}

function countInsertionsBefore(insertions: readonly number[], index: number): number {
  let count = 0;
  for (const insertion of insertions) {
    if (insertion >= index) {
      break;
    }
    count += 1;
  }
  return count;
}

function countInsertionsBeforeOrAt(insertions: readonly number[], index: number): number {
  let count = 0;
  for (const insertion of insertions) {
    if (insertion > index) {
      break;
    }
    count += 1;
  }
  return count;
}

function adjustStyleSpansForInsertedColons(
  styles: MarkdownStyleSpan[],
  insertionPositions: readonly number[],
): MarkdownStyleSpan[] {
  return styles.map((span) => {
    const startShift = countInsertionsBeforeOrAt(insertionPositions, span.start);
    let endShift = countInsertionsBefore(insertionPositions, span.end);

    if (span.style === "bold" && insertionPositions.includes(span.end)) {
      endShift += 1;
    }

    return {
      start: span.start + startShift,
      end: span.end + endShift,
      style: span.style,
    };
  });
}

function adjustLinkSpansForInsertedColons(
  links: MarkdownLinkSpan[],
  insertionPositions: readonly number[],
): MarkdownLinkSpan[] {
  return links.map((link) => ({
    start: link.start + countInsertionsBeforeOrAt(insertionPositions, link.start),
    end: link.end + countInsertionsBefore(insertionPositions, link.end),
    href: link.href,
  }));
}

function compactSlackLabelContinuations(ir: MarkdownIR): MarkdownIR {
  const text = ir.text ?? "";
  if (!text.includes("\n")) {
    return ir;
  }

  const protectedStyles = ir.styles.filter(
    (span) => span.style === "blockquote" || span.style === "code_block",
  );
  const segments: { lineEnd: number; paragraphEnd: number; continuationCount: number }[] = [];
  const insertionPositions: number[] = [];

  let lineStart = 0;
  while (lineStart < text.length) {
    const lineEnd = findLineEnd(text, lineStart);
    const line = text.slice(lineStart, lineEnd);

    if (
      line.startsWith("• ") &&
      !intersectsProtectedStyle(protectedStyles, lineStart, lineEnd) &&
      isBoldLabelLine(text, ir.styles, lineStart, lineEnd)
    ) {
      let paragraphEnd = lineEnd;
      let continuationCount = 0;
      let nextStart = lineEnd < text.length ? lineEnd + 1 : text.length;

      while (nextStart < text.length) {
        const nextLineEnd = findLineEnd(text, nextStart);
        const nextLine = text.slice(nextStart, nextLineEnd);
        if (
          !isSlackContinuationLine(nextLine) ||
          intersectsProtectedStyle(protectedStyles, nextStart, nextLineEnd)
        ) {
          break;
        }
        paragraphEnd = nextLineEnd;
        continuationCount += 1;
        nextStart = nextLineEnd < text.length ? nextLineEnd + 1 : text.length;
      }

      if (paragraphEnd > lineEnd) {
        segments.push({ lineEnd, paragraphEnd, continuationCount });
        insertionPositions.push(lineEnd);
        lineStart = paragraphEnd < text.length ? paragraphEnd + 1 : text.length;
        continue;
      }
    }

    lineStart = lineEnd < text.length ? lineEnd + 1 : text.length;
  }

  if (!segments.length) {
    return ir;
  }

  let compactedText = "";
  let cursor = 0;

  for (const segment of segments) {
    const body = text.slice(segment.lineEnd, segment.paragraphEnd);
    compactedText += text.slice(cursor, segment.lineEnd);
    compactedText += ":";
    compactedText += segment.continuationCount === 1 ? body.replace("\n", " ") : body;
    cursor = segment.paragraphEnd;
  }

  compactedText += text.slice(cursor);

  return {
    text: compactedText,
    styles: adjustStyleSpansForInsertedColons(ir.styles, insertionPositions),
    links: adjustLinkSpansForInsertedColons(ir.links, insertionPositions),
  };
}

export function markdownToSlackMrkdwn(
  markdown: string,
  options: SlackMarkdownOptions = {},
): string {
  const ir = compactSlackLabelContinuations(
    markdownToIR(markdown ?? "", {
      linkify: false,
      autolink: false,
      headingStyle: "bold",
      blockquotePrefix: "> ",
      tableMode: options.tableMode,
    }),
  );
  return renderMarkdownWithMarkers(ir, buildSlackRenderOptions());
}

export function normalizeSlackOutboundText(markdown: string): string {
  return markdownToSlackMrkdwn(markdown ?? "");
}

export function markdownToSlackMrkdwnChunks(
  markdown: string,
  limit: number,
  options: SlackMarkdownOptions = {},
): string[] {
  const ir = compactSlackLabelContinuations(
    markdownToIR(markdown ?? "", {
      linkify: false,
      autolink: false,
      headingStyle: "bold",
      blockquotePrefix: "> ",
      tableMode: options.tableMode,
    }),
  );
  const chunks = chunkMarkdownIR(ir, limit);
  const renderOptions = buildSlackRenderOptions();
  return chunks.map((chunk) => renderMarkdownWithMarkers(chunk, renderOptions));
}
