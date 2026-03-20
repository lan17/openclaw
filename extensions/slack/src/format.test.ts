import { describe, expect, it } from "vitest";
import {
  markdownToSlackMrkdwn,
  markdownToSlackMrkdwnChunks,
  normalizeSlackOutboundText,
} from "./format.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

describe("markdownToSlackMrkdwn", () => {
  it("handles core markdown formatting conversions", () => {
    const cases = [
      ["converts bold from double asterisks to single", "**bold text**", "*bold text*"],
      ["preserves italic underscore format", "_italic text_", "_italic text_"],
      [
        "converts strikethrough from double tilde to single",
        "~~strikethrough~~",
        "~strikethrough~",
      ],
      [
        "renders basic inline formatting together",
        "hi _there_ **boss** `code`",
        "hi _there_ *boss* `code`",
      ],
      ["renders inline code", "use `npm install`", "use `npm install`"],
      ["renders fenced code blocks", "```js\nconst x = 1;\n```", "```\nconst x = 1;\n```"],
      [
        "renders links with Slack mrkdwn syntax",
        "see [docs](https://example.com)",
        "see <https://example.com|docs>",
      ],
      ["does not duplicate bare URLs", "see https://example.com", "see https://example.com"],
      ["escapes unsafe characters", "a & b < c > d", "a &amp; b &lt; c &gt; d"],
      [
        "preserves Slack angle-bracket markup (mentions/links)",
        "hi <@U123> see <https://example.com|docs> and <!here>",
        "hi <@U123> see <https://example.com|docs> and <!here>",
      ],
      ["escapes raw HTML", "<b>nope</b>", "&lt;b&gt;nope&lt;/b&gt;"],
      ["renders paragraphs with blank lines", "first\n\nsecond", "first\n\nsecond"],
      ["renders bullet lists", "- one\n- two", "• one\n• two"],
      ["renders ordered lists with numbering", "2. two\n3. three", "2. two\n3. three"],
      ["renders headings as bold text", "# Title", "*Title*"],
      ["renders blockquotes", "> Quote", "> Quote"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(markdownToSlackMrkdwn(input), name).toBe(expected);
    }
  });

  it("handles nested list items", () => {
    const res = markdownToSlackMrkdwn("- item\n  - nested");
    // markdown-it correctly parses this as a nested list
    expect(res).toBe("• item\n  • nested");
  });

  it("compacts label-only bullet continuations", () => {
    const res = markdownToSlackMrkdwn(
      "- **Prompt injection defense**\n  Block or flag malicious instructions before they reach sensitive tools.",
    );
    expect(res).toBe(
      "• *Prompt injection defense:* Block or flag malicious instructions before they reach sensitive tools.",
    );
  });

  it("compacts hard line break label-only bullet continuations", () => {
    const res = markdownToSlackMrkdwn(
      "- **Prompt injection defense**  \n  Block or flag malicious instructions before they reach sensitive tools.",
    );
    expect(res).toBe(
      "• *Prompt injection defense:* Block or flag malicious instructions before they reach sensitive tools.",
    );
  });

  it("handles complex message with multiple elements", () => {
    const res = markdownToSlackMrkdwn(
      "**Important:** Check the _docs_ at [link](https://example.com)\n\n- first\n- second",
    );
    expect(res).toBe(
      "*Important:* Check the _docs_ at <https://example.com|link>\n\n• first\n• second",
    );
  });

  it("does not throw when input is undefined at runtime", () => {
    expect(markdownToSlackMrkdwn(undefined as unknown as string)).toBe("");
  });

  it("leaves nested bullets unchanged", () => {
    const res = markdownToSlackMrkdwn(
      "- **Prompt injection defense**\n  - nested bullet should stay nested",
    );
    expect(res).toBe("• *Prompt injection defense*\n  • nested bullet should stay nested");
  });

  it("leaves blockquote bullets unchanged", () => {
    const res = markdownToSlackMrkdwn(
      "> - **Prompt injection defense**\n>   Block or flag malicious instructions before they reach sensitive tools.",
    );
    expect(res).toBe(
      "> • *Prompt injection defense*\nBlock or flag malicious instructions before they reach sensitive tools.",
    );
  });

  it("leaves fenced code blocks unchanged", () => {
    const res = markdownToSlackMrkdwn(
      "```\n- **Prompt injection defense**\nBlock or flag malicious instructions before they reach sensitive tools.\n```",
    );
    expect(res).toBe(
      "```\n- **Prompt injection defense**\nBlock or flag malicious instructions before they reach sensitive tools.\n```",
    );
  });

  it("leaves loose-list paragraphs unchanged", () => {
    const res = markdownToSlackMrkdwn(
      "- **Prompt injection defense**\n\n  Block or flag malicious instructions before they reach sensitive tools.",
    );
    expect(res).toBe(
      "• *Prompt injection defense*Block or flag malicious instructions before they reach sensitive tools.",
    );
  });
});

describe("markdownToSlackMrkdwnChunks", () => {
  it("compacts label-only bullets before chunking", () => {
    const res = markdownToSlackMrkdwnChunks(
      "- **Prompt injection defense**\n  Block or flag malicious instructions before they reach sensitive tools.\n- Second bullet with enough text to force a second chunk after compaction.",
      100,
    );
    expect(res).toEqual([
      "• *Prompt injection defense:* Block or flag malicious instructions before they reach sensitive tools.",
      "• Second bullet with enough text to force a second chunk after compaction.",
    ]);
  });
});

describe("escapeSlackMrkdwn", () => {
  it("returns plain text unchanged", () => {
    expect(escapeSlackMrkdwn("heartbeat status ok")).toBe("heartbeat status ok");
  });

  it("escapes slack and mrkdwn control characters", () => {
    expect(escapeSlackMrkdwn("mode_*`~<&>\\")).toBe("mode\\_\\*\\`\\~&lt;&amp;&gt;\\\\");
  });
});

describe("normalizeSlackOutboundText", () => {
  it("normalizes markdown for outbound send/update paths", () => {
    expect(normalizeSlackOutboundText(" **bold** ")).toBe("*bold*");
  });

  it("compacts label-only bullet continuations", () => {
    expect(
      normalizeSlackOutboundText(
        "- **Prompt injection defense**\n  Block or flag malicious instructions before they reach sensitive tools.",
      ),
    ).toBe(
      "• *Prompt injection defense:* Block or flag malicious instructions before they reach sensitive tools.",
    );
  });
});
