/**
 * mcp-server/server.ts
 *
 * Exposes a subset of Crewm8's BuiltinTools over the MCP Streamable HTTP
 * transport so a remote hermes agent (100.127.242.92 via Tailscale) can
 * discover and invoke them without needing a local Electron process.
 *
 * Design notes:
 *  - Uses the high-level McpServer from @modelcontextprotocol/sdk/server/mcp.js
 *    rather than the low-level Server, because McpServer.tool() handles
 *    tools/list and tools/call dispatch automatically.
 *  - Each HTTP POST /mcp creates a fresh stateless StreamableHTTPServerTransport
 *    (sessionIdGenerator: undefined) so hermes does not need session affinity.
 *  - The ToolContext passed to builtin execute() is a synthetic stub — enough
 *    for workspace/command tools to work. AbortRegistry and bus are no-ops.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BuiltinTools } from "../application/lib/builtin-tools.js";
import type { ToolContext } from "../application/lib/exec-tool.js";
import type { IAbortRegistry } from "../runs/abort-registry.js";

// ---------------------------------------------------------------------------
// Logger — prefix-based console wrapper
// ---------------------------------------------------------------------------

const PREFIX = "[mcp-server]";

const log = {
    info: (...args: unknown[]) => console.log(PREFIX, ...args),
    warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
    error: (...args: unknown[]) => console.error(PREFIX, ...args),
};

// ---------------------------------------------------------------------------
// Allowlist — controlled via CREWM8_MCP_EXPOSE env var
// ---------------------------------------------------------------------------

const DEFAULT_EXPOSE = [
    "executeCommand",
    "workspace-readFile",
    "workspace-grep",
    "workspace-readdir",
    "workspace-writeFile",
    "parseFile",
] as const;

function getAllowedToolNames(): string[] {
    const raw = process.env.CREWM8_MCP_EXPOSE;
    if (raw && raw.trim().length > 0) {
        return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return [...DEFAULT_EXPOSE];
}

// ---------------------------------------------------------------------------
// Synthetic ToolContext factory
// ---------------------------------------------------------------------------

function makeNoOpAbortRegistry(): IAbortRegistry {
    return {
        createForRun: (_runId: string) => new AbortController().signal,
        registerProcess: (_runId: string, _proc: import("child_process").ChildProcess) => { /* no-op */ },
        unregisterProcess: (_runId: string, _proc: import("child_process").ChildProcess) => { /* no-op */ },
        abort: (_runId: string) => { /* no-op */ },
        forceAbort: (_runId: string) => { /* no-op */ },
        isAborted: (_runId: string) => false,
        cleanup: (_runId: string) => { /* no-op */ },
    };
}

function makeSyntheticContext(): ToolContext {
    const ac = new AbortController();
    return {
        runId: `mcp-${randomUUID()}`,
        signal: ac.signal,
        abortRegistry: makeNoOpAbortRegistry(),
    };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

// Extract the raw shape (field → schema map) from a Rowboat ZodObject. This
// supports both Zod v3 and v4 internal layouts because @modelcontextprotocol/sdk's
// registerTool() expects a ZodRawShapeCompat (Record<string, AnySchema>), not a
// ZodObject. Passing the ZodObject directly makes the SDK fail silently and
// return an empty `properties: {}` in tools/list — which then makes hermes's
// LLM think the tool takes no arguments and call it with {}.
function extractShape(inputSchema: unknown): Record<string, unknown> | undefined {
    if (!inputSchema || typeof inputSchema !== "object") return undefined;
    const s = inputSchema as {
        shape?: Record<string, unknown> | (() => Record<string, unknown>);
        _def?: { shape?: Record<string, unknown> | (() => Record<string, unknown>) };
        _zod?: { def?: { shape?: Record<string, unknown> | (() => Record<string, unknown>) } };
    };
    // v4 direct getter
    if (s.shape && typeof s.shape !== "function") return s.shape;
    if (typeof s.shape === "function") return (s.shape as () => Record<string, unknown>)();
    // v3 nested under _def
    const v3 = s._def?.shape;
    if (v3 && typeof v3 !== "function") return v3;
    if (typeof v3 === "function") return (v3 as () => Record<string, unknown>)();
    // v4 nested under _zod
    const v4 = s._zod?.def?.shape;
    if (v4 && typeof v4 !== "function") return v4;
    if (typeof v4 === "function") return (v4 as () => Record<string, unknown>)();
    return undefined;
}

function registerTools(mcpServer: McpServer, allowedNames: string[]): void {
    let registered = 0;

    for (const name of allowedNames) {
        const toolDef = (BuiltinTools as Record<string, unknown>)[name] as {
            description: string;
            inputSchema: unknown;
            execute: (input: unknown, ctx: ToolContext) => Promise<unknown>;
        } | undefined;

        if (!toolDef) {
            log.warn(`Tool '${name}' in allowlist not found in BuiltinTools registry — skipping`);
            continue;
        }

        const { description, inputSchema, execute } = toolDef;
        const shape = extractShape(inputSchema);

        if (!shape) {
            log.warn(`Tool '${name}' has no extractable shape — registering as zero-arg tool`);
        }

        // Use the new non-deprecated registerTool() API. It accepts either a
        // ZodRawShapeCompat (flat object of field → zod schema) or an AnySchema.
        // We pass the extracted shape so the SDK can build the JSON Schema for
        // tools/list correctly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mcpServer as any).registerTool(
            name,
            {
                description,
                inputSchema: shape ?? {},
            },
            async (args: Record<string, unknown>) => {
                const ctx = makeSyntheticContext();
                try {
                    const result = await execute(args, ctx);
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify(result, null, 2),
                            },
                        ],
                    };
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    log.error(`Tool '${name}' threw:`, message);
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify({ error: message }),
                            },
                        ],
                        isError: true,
                    };
                }
            },
        );

        registered++;
    }

    log.info(`Registered ${registered}/${allowedNames.length} allowed tools`);
}

// ---------------------------------------------------------------------------
// HTTP server lifecycle
// ---------------------------------------------------------------------------

let httpServer: http.Server | null = null;

/**
 * Start the MCP server on the given port bound to 0.0.0.0.
 *
 * Each POST /mcp request gets its own stateless StreamableHTTPServerTransport
 * and a fresh McpServer instance. Tools are stateless so there is no benefit
 * to a persistent session, and this avoids the complexity of session routing.
 */
export async function startMcpServer(port: number = 8643): Promise<void> {
    if (httpServer) {
        log.warn("MCP server already running — ignoring duplicate startMcpServer() call");
        return;
    }

    const allowedNames = getAllowedToolNames();
    log.info(`Starting on 0.0.0.0:${port} | exposed tools: ${allowedNames.join(", ")}`);

    httpServer = http.createServer((req, res) => {
        // Only accept POST /mcp (and a simple GET / health check)
        if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                ok: true,
                service: "crewm8-mcp-server",
                tools: allowedNames,
            }));
            return;
        }

        if (req.method !== "POST" || req.url !== "/mcp") {
            res.writeHead(req.method === "POST" ? 404 : 405, {
                "Content-Type": "application/json",
            });
            res.end(JSON.stringify({ error: "Use POST /mcp" }));
            return;
        }

        // Accumulate body before handing off to transport
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", async () => {
            let parsedBody: unknown;
            try {
                parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid JSON body" }));
                return;
            }

            // One transport instance per request (stateless mode)
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });

            const mcpServer = new McpServer({
                name: "crewm8-builtin-tools",
                version: "1.0.0",
            });

            registerTools(mcpServer, allowedNames);

            try {
                await mcpServer.connect(transport);
                await transport.handleRequest(req, res, parsedBody);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                log.error("Transport error handling request:", message);
                if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Internal server error" }));
                }
            } finally {
                transport.close().catch(() => { /* best-effort */ });
            }
        });

        req.on("error", (err) => {
            log.error("Request stream error:", err.message);
            if (!res.headersSent) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Request error" }));
            }
        });
    });

    // Graceful handling of EADDRINUSE — log and skip rather than crashing
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
            log.warn(`Port ${port} already in use — MCP server will NOT start.`);
            httpServer = null;
        } else {
            log.error("HTTP server error:", err.message);
        }
    });

    await new Promise<void>((resolve) => {
        httpServer!.listen(port, "0.0.0.0", () => {
            log.info(`Listening on 0.0.0.0:${port}`);
            resolve();
        });
    });
}

/**
 * Gracefully stop the MCP server.
 */
export async function stopMcpServer(): Promise<void> {
    if (!httpServer) return;

    const server = httpServer;
    httpServer = null;

    await new Promise<void>((resolve) => {
        server.close(() => {
            log.info("Stopped");
            resolve();
        });
    });
}
