/**
 * Custom fetch wrapper for hermes gateway connections.
 *
 * Problem: hermes forwards responses from models (e.g. xiaomi/mimo-v2-pro)
 * that include non-standard fields in their SSE streaming chunks —
 * `reasoning`, `reasoning_content`, provider-specific metadata, etc.
 * The Vercel AI SDK's internal validator uses strict schema checking on
 * each chunk and throws AI_TypeValidationError when it sees unknown fields.
 * This kills the entire stream on the first chunk, so no content ever
 * reaches the user.
 *
 * Fix: intercept the streaming response body and normalize each SSE
 * `data:` line to contain only standard OpenAI chat completion fields.
 * The AI SDK's validator then passes, and content streams through normally.
 *
 * This wrapper is ONLY used for the hermes `openai-compatible` provider.
 * All other providers (OpenRouter, direct OpenAI, etc.) use standard fetch.
 */

type FetchFn = typeof globalThis.fetch;

/**
 * Standard OpenAI chat.completion.chunk fields. Everything else gets stripped.
 */
function normalizeChunkJson(raw: string): string {
    try {
        const chunk = JSON.parse(raw);
        // Build a clean chunk with only standard fields
        const clean: Record<string, unknown> = {};
        if (chunk.id != null) clean.id = chunk.id;
        if (chunk.object != null) clean.object = chunk.object;
        if (chunk.created != null) clean.created = chunk.created;
        if (chunk.model != null) clean.model = chunk.model;
        if (chunk.system_fingerprint != null) clean.system_fingerprint = chunk.system_fingerprint;
        if (chunk.usage != null) clean.usage = chunk.usage;

        if (Array.isArray(chunk.choices)) {
            clean.choices = chunk.choices.map((choice: Record<string, unknown>) => {
                const cleanChoice: Record<string, unknown> = {};
                if (choice.index != null) cleanChoice.index = choice.index;
                if (choice.finish_reason !== undefined) cleanChoice.finish_reason = choice.finish_reason;
                if (choice.logprobs !== undefined) cleanChoice.logprobs = choice.logprobs;

                if (choice.delta && typeof choice.delta === 'object') {
                    const delta = choice.delta as Record<string, unknown>;
                    const cleanDelta: Record<string, unknown> = {};
                    if (delta.role != null) cleanDelta.role = delta.role;
                    if (delta.content != null) cleanDelta.content = delta.content;
                    if (delta.tool_calls != null) cleanDelta.tool_calls = delta.tool_calls;
                    if (delta.function_call != null) cleanDelta.function_call = delta.function_call;
                    if (delta.refusal != null) cleanDelta.refusal = delta.refusal;
                    cleanChoice.delta = cleanDelta;
                }
                return cleanChoice;
            });
        }
        return JSON.stringify(clean);
    } catch {
        // If we can't parse it (shouldn't happen), pass through unchanged
        return raw;
    }
}

/**
 * Creates a TransformStream that processes SSE lines and normalizes the
 * JSON payload of each `data:` line. Non-data lines (comments, empty
 * lines, event: lines) pass through unchanged.
 */
function createSseNormalizerStream(): TransformStream<string, string> {
    return new TransformStream<string, string>({
        transform(line, controller) {
            if (line.startsWith('data: ')) {
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') {
                    controller.enqueue(line);
                } else {
                    controller.enqueue('data: ' + normalizeChunkJson(payload));
                }
            } else {
                controller.enqueue(line);
            }
        },
    });
}

/**
 * Splits a byte stream into individual SSE lines (splitting on \n).
 * Each yielded string is one line including trailing \n.
 */
function createLineSplitter(): TransformStream<Uint8Array, string> {
    const decoder = new TextDecoder();
    let buffer = '';

    return new TransformStream<Uint8Array, string>({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            // Keep the last (potentially incomplete) segment in the buffer
            buffer = lines.pop() || '';
            for (const line of lines) {
                controller.enqueue(line);
            }
        },
        flush(controller) {
            if (buffer) {
                controller.enqueue(buffer);
            }
        },
    });
}

/**
 * Re-encodes strings back to bytes with \n after each line.
 */
function createLineEncoder(): TransformStream<string, Uint8Array> {
    const encoder = new TextEncoder();
    return new TransformStream<string, Uint8Array>({
        transform(line, controller) {
            controller.enqueue(encoder.encode(line + '\n'));
        },
    });
}

/**
 * Returns a fetch wrapper that normalizes SSE streaming responses from
 * hermes so the Vercel AI SDK's strict validator doesn't choke on
 * non-standard fields.
 *
 * Non-streaming responses pass through unchanged.
 */
export function createHermesCompatFetch(baseFetch?: FetchFn): FetchFn {
    const realFetch = baseFetch ?? globalThis.fetch;

    return async function hermesFetch(
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> {
        const response = await realFetch(input, init);

        const contentType = response.headers.get('content-type') || '';
        const isStreaming = contentType.includes('text/event-stream') ||
                           contentType.includes('text/plain'); // some gateways use text/plain for SSE

        if (!isStreaming || !response.body) {
            return response;
        }

        // Pipe through: bytes → lines → normalize → bytes
        const normalizedBody = response.body
            .pipeThrough(createLineSplitter())
            .pipeThrough(createSseNormalizerStream())
            .pipeThrough(createLineEncoder());

        return new Response(normalizedBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };
}
