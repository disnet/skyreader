// Worker entry for extractPdfInWorker (pdf-extract.ts): one parse at a time per
// worker, so a PDF never holds the proxy's main thread.
import { extractPdf, type PdfWorkerReply, type PdfWorkerRequest } from './pdf-extract';

declare const self: Worker;

self.onmessage = async (event: MessageEvent<PdfWorkerRequest>) => {
  let reply: PdfWorkerReply;
  try {
    const { bytes, budgetMs } = event.data;
    reply = { ok: true, result: await extractPdf(bytes, { budgetMs, ownsBytes: true }) };
  } catch (err) {
    reply = {
      ok: false,
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  self.postMessage(reply);
};
