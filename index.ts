/**
 * Mermaid Render Extension
 *
 * Automatically detects ```mermaid``` code blocks in assistant messages,
 * renders them to ASCII/Unicode art with beautiful-mermaid, and displays
 * them in Pi's transcript via a custom message renderer.
 *
 * The renderer leans on Pi's built-in collapsed/expanded transcript behavior:
 * - collapsed: summary + compact preview of the first successfully rendered diagram
 * - expanded: all diagrams stacked, plus diagnostics/source for failures
 *
 * Rendering happens in worker threads via a background queue so Mermaid
 * rendering never blocks Pi's main event loop or normal interaction.
 */

import { Worker } from "node:worker_threads";

import { getMarkdownTheme, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

const CUSTOM_TYPE = "mermaid-render";
const COLLAPSED_MAX_LINES = 18;
const COLLAPSED_MAX_COLUMNS = 96;
const SECTION_SEPARATOR = "─".repeat(32);
const RENDER_TIMEOUT_MS = 8_000;
const RENDER_WORKER_URL = new URL("./render-worker.mjs", import.meta.url);
const ASCII_RENDER_OPTIONS = {
  colorMode: "none" as const,
  paddingX: 1,
  paddingY: 1,
  boxBorderPadding: 0,
};

interface MermaidDiagramRender {
  index: number;
  label: string;
  source: string;
  ascii?: string;
  error?: string;
  fullError?: string;
}

interface MermaidRenderDetails {
  count: number;
  renderedCount: number;
  failedCount: number;
  diagrams: MermaidDiagramRender[];
}

interface MermaidTextContent {
  type: "text";
  text: string;
}

interface MermaidRenderWorkerRequest {
  source: string;
  options: typeof ASCII_RENDER_OPTIONS;
}

interface MermaidRenderWorkerResult {
  ascii?: string;
  error?: string;
  fullError?: string;
}

interface MermaidRenderJob {
  blocks: string[];
  appendTroubleshootingPrompt: (prompt: string) => void;
}

function extractMermaidBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```mermaid\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const source = match[1].trim();
    if (source) blocks.push(source);
  }

  return blocks;
}

function getTextBlocks(content: string | MermaidTextContent[]): MermaidTextContent[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.filter((block): block is MermaidTextContent => block.type === "text");
}

function truncateAscii(ascii: string, maxLines: number, maxColumns: number): { text: string; truncated: boolean } {
  const lines = ascii.split("\n");
  let truncated = false;

  const clippedLines = lines.slice(0, maxLines).map((line) => {
    if (line.length <= maxColumns) return line;
    truncated = true;
    return `${line.slice(0, Math.max(0, maxColumns - 1))}…`;
  });

  if (lines.length > maxLines) truncated = true;

  return {
    text: clippedLines.join("\n"),
    truncated,
  };
}

function formatSummary(details: MermaidRenderDetails): string {
  if (details.failedCount === 0) {
    return details.count === 1
      ? "✓ Mermaid diagram rendered as ASCII"
      : `✓ Mermaid diagrams rendered as ASCII — ${details.count} diagrams`;
  }

  if (details.renderedCount === 0) {
    return details.count === 1
      ? "✗ Mermaid diagram failed to render"
      : `✗ Mermaid diagrams failed to render — ${details.failedCount}/${details.count} failed`;
  }

  return `⚠ Mermaid diagrams rendered with errors — ${details.renderedCount} rendered, ${details.failedCount} failed`;
}

function getPreviewDiagram(details: MermaidRenderDetails): MermaidDiagramRender | undefined {
  return details.diagrams.find((diagram) => diagram.ascii) ?? details.diagrams[0];
}

function buildFailureMarkdown(diagram: MermaidDiagramRender): string {
  return [
    "**Error output**",
    "```text",
    diagram.fullError ?? diagram.error ?? "Unknown Mermaid render error",
    "```",
    "",
    "**Original diagram**",
    "```mermaid",
    diagram.source,
    "```",
  ].join("\n");
}

function buildTroubleshootingPrompt(diagram: MermaidDiagramRender): string {
  return [
    `Mermaid rendering failed${diagram.label}. Help me diagnose and fix this diagram for beautiful-mermaid ASCII rendering.`,
    "",
    "Error output:",
    diagram.fullError ?? diagram.error ?? "Unknown Mermaid render error",
    "",
    "Original diagram:",
    "```mermaid",
    diagram.source,
    "```",
  ].join("\n");
}

function renderDiagramInWorker(source: string): Promise<MermaidRenderWorkerResult> {
  return new Promise((resolve) => {
    const worker = new Worker(RENDER_WORKER_URL, { type: "module", execArgv: [] });
    let settled = false;

    const finish = (result: MermaidRenderWorkerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.removeAllListeners();
      void worker.terminate().catch(() => {});
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({
        error: `Mermaid render timed out after ${Math.floor(RENDER_TIMEOUT_MS / 1000)}s`,
        fullError: `Rendering exceeded the timeout of ${RENDER_TIMEOUT_MS}ms and the worker was terminated.`,
      });
    }, RENDER_TIMEOUT_MS);

    worker.once("message", (result: MermaidRenderWorkerResult) => finish(result));
    worker.once("error", (err: Error) => {
      finish({
        error: err.message,
        fullError: err.stack ?? err.message,
      });
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish({
          error: `Mermaid render worker exited with code ${code}`,
          fullError: `Mermaid render worker exited unexpectedly with code ${code}.`,
        });
      }
    });

    const request: MermaidRenderWorkerRequest = { source, options: ASCII_RENDER_OPTIONS };
    worker.postMessage(request);
  });
}

export default function mermaidRender(pi: ExtensionAPI) {
  const renderQueue: MermaidRenderJob[] = [];
  let isProcessingQueue = false;

  async function processRenderJob(job: MermaidRenderJob): Promise<void> {
    const diagrams: MermaidDiagramRender[] = [];

    for (let i = 0; i < job.blocks.length; i++) {
      const source = job.blocks[i]!;
      const label = job.blocks.length > 1 ? ` (${i + 1}/${job.blocks.length})` : "";

      try {
        const result = await renderDiagramInWorker(source);
        if (result.ascii) {
          diagrams.push({ index: i, label, source, ascii: result.ascii });
        } else {
          diagrams.push({
            index: i,
            label,
            source,
            error: result.error ?? "Mermaid render failed",
            fullError: result.fullError ?? result.error ?? "Mermaid render failed",
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        diagrams.push({
          index: i,
          label,
          source,
          error: msg,
          fullError: err instanceof Error ? (err.stack ?? msg) : msg,
        });
      }
    }

    for (const diagram of diagrams) {
      if (!diagram.error) continue;
      job.appendTroubleshootingPrompt(buildTroubleshootingPrompt(diagram));
    }

    const details = {
      count: diagrams.length,
      renderedCount: diagrams.filter((diagram) => Boolean(diagram.ascii)).length,
      failedCount: diagrams.filter((diagram) => Boolean(diagram.error)).length,
      diagrams,
    } satisfies MermaidRenderDetails;

    pi.sendMessage({
      customType: CUSTOM_TYPE,
      content: [{ type: "text", text: formatSummary(details) }],
      display: true,
      details,
    });
  }

  async function processRenderQueue(): Promise<void> {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
      while (renderQueue.length > 0) {
        const job = renderQueue.shift();
        if (!job) continue;

        try {
          await processRenderJob(job);
        } catch (err) {
          console.error("[pi-mermaid-render] Failed to process render job:", err);
        }
      }
    } finally {
      isProcessingQueue = false;
      if (renderQueue.length > 0) {
        void processRenderQueue();
      }
    }
  }

  function enqueueRenderJob(job: MermaidRenderJob): void {
    renderQueue.push(job);
    void processRenderQueue();
  }

  pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded }, theme) => {
    const details = message.details as MermaidRenderDetails | undefined;
    const markdownTheme = getMarkdownTheme();
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

    if (!details) {
      box.addChild(new Text(theme.fg("error", "[mermaid] Missing render details"), 0, 0));
      return box;
    }

    const textBlocks = getTextBlocks(message.content);
    const summary = textBlocks[0]?.text ?? formatSummary(details);
    const previewDiagram = getPreviewDiagram(details);

    box.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m[mermaid]\x1b[22m"), 0, 0));
    box.addChild(new Spacer(1));
    box.addChild(
      new Text(
        details.failedCount > 0 && details.renderedCount === 0
          ? theme.fg("error", summary)
          : details.failedCount > 0
            ? `${theme.fg("warning", summary)}${theme.fg("dim", expanded ? "" : " — expand for details")}`
            : `${theme.fg("success", summary)}${theme.fg("dim", expanded ? "" : " — expand to see all diagrams")}`,
        0,
        0,
      ),
    );

    if (!expanded) {
      if (previewDiagram?.ascii) {
        const preview = truncateAscii(previewDiagram.ascii, COLLAPSED_MAX_LINES, COLLAPSED_MAX_COLUMNS);

        box.addChild(new Spacer(1));
        box.addChild(
          new Text(
            theme.fg("dim", `Previewing diagram ${previewDiagram.index + 1}/${details.count}`),
            0,
            0,
          ),
        );
        box.addChild(new Spacer(1));
        box.addChild(new Text(theme.fg("customMessageText", preview.text), 0, 0));

        if (preview.truncated) {
          box.addChild(new Spacer(1));
          box.addChild(new Text(theme.fg("dim", "Preview truncated — expand to see all diagrams"), 0, 0));
        }
      } else if (previewDiagram?.error) {
        box.addChild(new Spacer(1));
        box.addChild(new Text(theme.fg("dim", `Diagram ${previewDiagram.index + 1}/${details.count} failed`), 0, 0));
        box.addChild(new Spacer(1));
        box.addChild(new Text(theme.fg("error", previewDiagram.error), 0, 0));
      }

      return box;
    }

    for (let i = 0; i < details.diagrams.length; i++) {
      const diagram = details.diagrams[i]!;

      box.addChild(new Spacer(1));
      box.addChild(
        new Text(
          theme.fg(
            diagram.ascii ? "customMessageText" : "error",
            `Diagram ${diagram.index + 1} of ${details.count}${diagram.ascii ? "" : " — failed"}`,
          ),
          0,
          0,
        ),
      );
      box.addChild(new Spacer(1));

      if (diagram.ascii) {
        box.addChild(new Text(theme.fg("customMessageText", diagram.ascii), 0, 0));
      } else {
        box.addChild(new Text(theme.fg("error", diagram.error ?? "Mermaid render failed"), 0, 0));
        box.addChild(new Spacer(1));
        box.addChild(
          new Markdown(buildFailureMarkdown(diagram), 0, 0, markdownTheme, {
            color: (text: string) => theme.fg("customMessageText", text),
          }),
        );
      }

      if (i < details.diagrams.length - 1) {
        box.addChild(new Spacer(1));
        box.addChild(new Text(theme.fg("dim", SECTION_SEPARATOR), 0, 0));
      }
    }

    return box;
  });

  pi.on("context", (event, _ctx) => {
    return {
      messages: event.messages.filter((message) => {
        return !(message.role === "custom" && message.customType === CUSTOM_TYPE);
      }),
    };
  });

  pi.on("message_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (event.message.role !== "assistant") return;

    const fullText = event.message.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");

    if (!fullText) return;

    const blocks = extractMermaidBlocks(fullText);
    if (blocks.length === 0) return;

    enqueueRenderJob({
      blocks,
      appendTroubleshootingPrompt: (prompt: string) => {
        const currentEditorText = ctx.ui.getEditorText();
        if (currentEditorText.trim().length === 0) {
          ctx.ui.setEditorText(prompt);
        } else {
          ctx.ui.pasteToEditor(`\n\n${prompt}`);
        }
      },
    });
  });
}
