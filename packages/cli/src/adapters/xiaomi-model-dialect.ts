/**
 * XiaomiModelDialect — Layer 2 dialect for Xiaomi (MiMo) models.
 *
 * Handles Xiaomi-specific quirks:
 * - 64-char tool name limit (OpenAI standard, strictly enforced by Xiaomi API)
 * - Strips unsupported thinking params
 * - Context window comes dynamically from OpenRouter model catalog
 */

import { log } from "../logger.js";
import { type AdapterResult, BaseAPIFormat, matchesModelFamily } from "./base-api-format.js";

export class XiaomiModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  override getToolNameLimit(): number {
    return 64;
  }

  override prepareRequest(request: any, originalRequest: any): any {
    // Xiaomi doesn't support thinking params
    if (originalRequest.thinking) {
      log("[XiaomiModelDialect] Stripping thinking object (not supported by Xiaomi API)");
      delete request.thinking;
    }

    // Truncate tool names to 64 chars
    this.truncateToolNames(request);
    if (request.messages) {
      this.truncateToolNamesInMessages(request.messages);
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "xiaomi") || matchesModelFamily(modelId, "mimo");
  }

  getName(): string {
    return "XiaomiModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use XiaomiModelDialect */
export { XiaomiModelDialect as XiaomiAdapter };
