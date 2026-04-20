/**
 * Mermaid Render Extension
 *
 * Automatically detects ```mermaid``` code blocks in assistant messages,
 * renders them to PNG with mermaid-cli, and displays them in Pi's transcript
 * via a custom message renderer.
 *
 * The renderer uses Pi's native Image component and leans on Pi's built-in
 * collapsed/expanded transcript behavior:
 * - collapsed: rendered image + clickable file:// link
 * - expanded: additional details such as file path, original diagram source,
 *   and full error output for failures
 *
 * Generated files are stored in /tmp/pi-mermaid-renders/ and are not cleaned
 * up automatically.
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getMarkdownTheme, type ExtensionAPI, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Box, Image, Markdown, Spacer, Text, hyperlink } from "@mariozechner/pi-tui";

const RENDER_DIR = "/tmp/pi-mermaid-renders";
const PUPPETEER_CONFIG_PATH = join(RENDER_DIR, "puppeteer-config.json");
const MMDC_TIMEOUT_MS = 30_000;
const CUSTOM_TYPE = "mermaid-render";

const PUPPETEER_CONFIG = JSON.stringify({
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const MMDC_BIN = join(__dirname, "node_modules", ".bin", "mmdc");

interface MermaidRenderDetails {
  label: string;
  source: string;
  pngPath?: string;
  error?: string;
  fullError?: string;
}

interface MermaidImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

interface MermaidTextContent {
  type: "text";
  text: string;
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

function getTextBlocks(content: string | (MermaidTextContent | MermaidImageContent)[]): MermaidTextContent[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.filter((block): block is MermaidTextContent => block.type === "text");
}

function getImageBlock(content: string | (MermaidTextContent | MermaidImageContent)[]): MermaidImageContent | undefined {
  if (typeof content === "string") return undefined;
  return content.find((block): block is MermaidImageContent => block.type === "image");
}

async function ensureRenderDir(): Promise<void> {
  await mkdir(RENDER_DIR, { recursive: true });

  await withFileMutationQueue(PUPPETEER_CONFIG_PATH, async () => {
    try {
      await access(PUPPETEER_CONFIG_PATH);
    } catch {
      await writeFile(PUPPETEER_CONFIG_PATH, PUPPETEER_CONFIG, "utf8");
    }
  });
}

async function renderToPng(pi: ExtensionAPI, source: string): Promise<string> {
  await ensureRenderDir();

  const id = randomUUID();
  const inputFile = join(RENDER_DIR, `${id}.mmd`);
  const outputFile = join(RENDER_DIR, `${id}.png`);

  await writeFile(inputFile, source, "utf8");

  const result = await pi.exec(
    MMDC_BIN,
    [
      "--input", inputFile,
      "--output", outputFile,
      "--backgroundColor", "transparent",
      "--puppeteerConfigFile", PUPPETEER_CONFIG_PATH,
      "--quiet",
    ],
    { timeout: MMDC_TIMEOUT_MS },
  );

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `mmdc exited with code ${result.code}`);
  }

  return outputFile;
}

export default function mermaidRender(pi: ExtensionAPI) {
  pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded }, theme) => {
    const details = message.details as MermaidRenderDetails | undefined;
    const markdownTheme = getMarkdownTheme();
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

    if (!details) {
      box.addChild(new Text(theme.fg("error", "[mermaid] Missing render details"), 0, 0));
      return box;
    }

    const textBlocks = getTextBlocks(message.content);
    const summary = textBlocks[0]?.text ?? "Mermaid render";
    const imageBlock = getImageBlock(message.content);

    if (details.error) {
      box.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m[mermaid]\x1b[22m"), 0, 0));
      box.addChild(new Spacer(1));
      box.addChild(
        new Text(
          `${theme.fg("error", "✗ Mermaid render failed")}${details.label}${theme.fg("dim", " — expand for full diagnostics")}`,
          0,
          0,
        ),
      );
      box.addChild(new Spacer(1));
      box.addChild(new Text(theme.fg("dim", summary), 0, 0));

      if (expanded) {
        const expandedMarkdown = [
          "**Error output**",
          "```text",
          details.fullError ?? details.error,
          "```",
          "",
          "**Original diagram**",
          "```mermaid",
          details.source,
          "```",
        ].join("\n");

        box.addChild(new Spacer(1));
        box.addChild(
          new Markdown(expandedMarkdown, 0, 0, markdownTheme, {
            color: (text: string) => theme.fg("customMessageText", text),
          }),
        );
      }

      return box;
    }

    const fileUri = details.pngPath ? `file://${details.pngPath}` : undefined;
    const openLink = fileUri ? hyperlink("Open rendered PNG", fileUri) : "Open rendered PNG";

    box.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m[mermaid]\x1b[22m"), 0, 0));
    box.addChild(new Spacer(1));
    box.addChild(
      new Text(
        `${theme.fg("success", "✓ Mermaid diagram rendered")}${details.label}${theme.fg("dim", " — expand for source/details")}`,
        0,
        0,
      ),
    );

    if (imageBlock) {
      const imageOptions = expanded
        ? { maxWidthCells: 80, maxHeightCells: 40, filename: `mermaid${details.label}.png` }
        : { maxWidthCells: 40, maxHeightCells: 16, filename: `mermaid${details.label}.png` };

      box.addChild(new Spacer(1));
      box.addChild(
        new Image(
          imageBlock.data,
          imageBlock.mimeType,
          { fallbackColor: (s) => theme.fg("dim", s) },
          imageOptions,
        ),
      );
    }

    box.addChild(new Spacer(1));
    box.addChild(new Text(`${theme.fg("dim", "File:")} ${openLink}`, 0, 0));

    if (expanded) {
      const expandedMarkdown = [
        fileUri ? `**Rendered file:** [${fileUri}](${fileUri})` : undefined,
        "",
        "**Original diagram**",
        "```mermaid",
        details.source,
        "```",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      box.addChild(new Spacer(1));
      box.addChild(
        new Markdown(expandedMarkdown, 0, 0, markdownTheme, {
          color: (text: string) => theme.fg("customMessageText", text),
        }),
      );
    }

    return box;
  });

  pi.on("message_end", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (event.message.role !== "assistant") return;

    const fullText = event.message.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");

    if (!fullText) return;

    const blocks = extractMermaidBlocks(fullText);
    if (blocks.length === 0) return;

    for (let i = 0; i < blocks.length; i++) {
      const source = blocks[i];
      const label = blocks.length > 1 ? ` (${i + 1}/${blocks.length})` : "";

      try {
        const pngPath = await renderToPng(pi, source);
        const base64 = (await readFile(pngPath)).toString("base64");
        const fileUri = `file://${pngPath}`;

        pi.sendMessage({
          customType: CUSTOM_TYPE,
          content: [
            { type: "text", text: `Rendered Mermaid diagram${label}` },
            { type: "image", data: base64, mimeType: "image/png" },
            { type: "text", text: `Open rendered PNG: ${fileUri}` },
          ],
          display: true,
          details: { label, pngPath, source } satisfies MermaidRenderDetails,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const fullError = (err as { stderr?: string }).stderr ?? msg;
        const summary = fullError.slice(0, 300);

        pi.sendMessage({
          customType: CUSTOM_TYPE,
          content: [{ type: "text", text: summary }],
          display: true,
          details: {
            label,
            source,
            error: summary,
            fullError,
          } satisfies MermaidRenderDetails,
        });

        const troubleshootingPrompt = [
          `Mermaid rendering failed${label}. Help me diagnose and fix this diagram for mermaid-cli.`,
          "",
          "Error output:",
          fullError,
          "",
          "Original diagram:",
          "```mermaid",
          source,
          "```",
        ].join("\n");

        const currentEditorText = ctx.ui.getEditorText();
        if (currentEditorText.trim().length === 0) {
          ctx.ui.setEditorText(troubleshootingPrompt);
        } else {
          ctx.ui.pasteToEditor(`\n\n${troubleshootingPrompt}`);
        }
      }
    }
  });
}
