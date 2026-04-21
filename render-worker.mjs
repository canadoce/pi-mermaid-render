import { parentPort } from "node:worker_threads";
import { renderMermaidASCII } from "beautiful-mermaid";

if (!parentPort) {
  throw new Error("Mermaid render worker started without a parent port");
}

parentPort.on("message", (request) => {
  const { source, options } = request;

  try {
    const ascii = renderMermaidASCII(source, options);
    parentPort.postMessage({ ascii });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort.postMessage({
      error: message,
      fullError: err instanceof Error ? (err.stack ?? message) : message,
    });
  }
});
