import fs from 'fs';
import path from 'path';
import { NodeHtmlMarkdown } from 'node-html-markdown'
import { WorkDir } from '../config/config.js';
import { serviceLogger, type ServiceRunContext } from '../services/service_logger.js';
import { limitEventItems } from './limit_event_items.js';
import { executeAction } from '../composio/client.js';
import { composioAccountsRepo } from '../composio/repo.js';
import { createEvent } from './track/events.js';

// Configuration
const SYNC_DIR = path.join(WorkDir, 'gmail_sync');
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const MAX_THREADS_IN_DIGEST = 10;
const nhm = new NodeHtmlMarkdown();

interface SyncedThread {
    threadId: string;
    markdown: string;
}

function summarizeGmailSync(threads: SyncedThread[]): string {
    const lines: string[] = [
        `# Gmail sync update`,
        ``,
        `${threads.length} new/updated thread${threads.length === 1 ? '' : 's'}.`,
        ``,
    ];

    const shown = threads.slice(0, MAX_THREADS_IN_DIGEST);
    const hidden = threads.length - shown.length;

    if (shown.length > 0) {
        lines.push(`## Threads`, ``);
        for (const { markdown } of shown) {
            lines.push(markdown.trimEnd(), ``, `---`, ``);
        }
        if (hidden > 0) {
            lines.push(`_…and ${hidden} more thread(s) omitted from digest._`, ``);
        }
    }

    return lines.join('\n');
}

async function publishGmailSyncEvent(threads: SyncedThread[]): Promise<void> {
    if (threads.length === 0) return;
    try {
        await createEvent({
            source: 'gmail',
            type: 'email.synced',
            createdAt: new Date().toISOString(),
            payload: summarizeGmailSync(threads),
        });
    } catch (err) {
        console.error('[Gmail] Failed to publish sync event:', err);
    }
}

// --- Wake Signal for Immediate Sync Trigger ---
let wakeResolve: (() => void) | null = null;

export function triggerSync(): void {
    if (wakeResolve) {
        console.log('[Gmail] Triggered - waking up immediately');
        wakeResolve();
        wakeResolve = null;
    }
}

function interruptibleSleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            wakeResolve = null;
            resolve();
        }, ms);
        wakeResolve = () => {
            clearTimeout(timeout);
            resolve();
        };
    });
}

// --- Helper Functions ---

function cleanFilename(name: string): string {
    return name.replace(/[\\/*?:":<>|]/g, "").substring(0, 100).trim();
}

// --- Composio-based Sync ---

const COMPOSIO_LOOKBACK_DAYS = 7;

interface ComposioSyncState {
    last_sync: string; // ISO string
}

function loadComposioState(stateFile: string): ComposioSyncState | null {
    if (fs.existsSync(stateFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            if (data.last_sync) {
                return { last_sync: data.last_sync };
            }
        } catch (e) {
            console.error('[Gmail] Failed to load composio state:', e);
        }
    }
    return null;
}

function saveComposioState(stateFile: string, lastSync: string): void {
    fs.writeFileSync(stateFile, JSON.stringify({ last_sync: lastSync }, null, 2));
}

function tryParseDate(dateStr: string): Date | null {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
}

interface ParsedMessage {
    from: string;
    date: string;
    subject: string;
    body: string;
}

function parseMessageData(messageData: Record<string, unknown>): ParsedMessage {
    const headers = messageData.payload && typeof messageData.payload === 'object'
        ? (messageData.payload as Record<string, unknown>).headers as Array<{ name: string; value: string }> | undefined
        : undefined;

    const from = headers?.find(h => h.name === 'From')?.value || String(messageData.from || messageData.sender || 'Unknown');
    const date = headers?.find(h => h.name === 'Date')?.value || String(messageData.date || messageData.internalDate || 'Unknown');
    const subject = headers?.find(h => h.name === 'Subject')?.value || String(messageData.subject || '(No Subject)');

    let body = '';

    if (messageData.payload && typeof messageData.payload === 'object') {
        body = extractBodyFromPayload(messageData.payload as Record<string, unknown>);
    }

    if (!body) {
        if (typeof messageData.body === 'string') {
            body = messageData.body;
        } else if (typeof messageData.snippet === 'string') {
            body = messageData.snippet;
        } else if (typeof messageData.text === 'string') {
            body = messageData.text;
        }
    }

    if (body && (body.includes('<html') || body.includes('<div') || body.includes('<p'))) {
        body = nhm.translate(body);
    }

    if (body) {
        body = body.split('\n').filter((line: string) => !line.trim().startsWith('>')).join('\n');
    }

    return { from, date, subject, body };
}

function extractBodyFromPayload(payload: Record<string, unknown>): string {
    const parts = payload.parts as Array<Record<string, unknown>> | undefined;

    if (parts) {
        for (const part of parts) {
            const mimeType = part.mimeType as string | undefined;
            const bodyData = part.body && typeof part.body === 'object'
                ? (part.body as Record<string, unknown>).data as string | undefined
                : undefined;

            if ((mimeType === 'text/plain' || mimeType === 'text/html') && bodyData) {
                const decoded = Buffer.from(bodyData, 'base64').toString('utf-8');
                if (mimeType === 'text/html') {
                    return nhm.translate(decoded);
                }
                return decoded;
            }

            if (part.parts) {
                const result = extractBodyFromPayload(part as Record<string, unknown>);
                if (result) return result;
            }
        }
    }

    const bodyData = payload.body && typeof payload.body === 'object'
        ? (payload.body as Record<string, unknown>).data as string | undefined
        : undefined;

    if (bodyData) {
        const decoded = Buffer.from(bodyData, 'base64').toString('utf-8');
        const mimeType = payload.mimeType as string | undefined;
        if (mimeType === 'text/html') {
            return nhm.translate(decoded);
        }
        return decoded;
    }

    return '';
}

interface ComposioThreadResult {
    synced: SyncedThread | null;
    newestIsoPlusOne: string | null;
}

async function processThreadComposio(connectedAccountId: string, threadId: string, syncDir: string): Promise<ComposioThreadResult> {
    let threadResult;
    try {
        threadResult = await executeAction(
            'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
            {
                connected_account_id: connectedAccountId,
                user_id: 'crewm8-user',
                version: 'latest',
                arguments: { thread_id: threadId, user_id: 'me' },
            }
        );
    } catch (error) {
        console.warn(`[Gmail] Skipping thread ${threadId} (fetch failed):`, error instanceof Error ? error.message : error);
        return { synced: null, newestIsoPlusOne: null };
    }

    if (!threadResult.successful || !threadResult.data) {
        console.error(`[Gmail] Failed to fetch thread ${threadId}:`, threadResult.error);
        return { synced: null, newestIsoPlusOne: null };
    }

    const data = threadResult.data as Record<string, unknown>;
    const messages = data.messages as Array<Record<string, unknown>> | undefined;

    let newestDate: Date | null = null;
    let mdContent: string;
    let subjectForLog: string;

    if (!messages || messages.length === 0) {
        const parsed = parseMessageData(data);
        mdContent = `# ${parsed.subject}\n\n` +
            `**Thread ID:** ${threadId}\n` +
            `**Message Count:** 1\n\n---\n\n` +
            `### From: ${parsed.from}\n` +
            `**Date:** ${parsed.date}\n\n` +
            `${parsed.body}\n\n---\n\n`;
        subjectForLog = parsed.subject;
        newestDate = tryParseDate(parsed.date);
    } else {
        const firstParsed = parseMessageData(messages[0]);
        mdContent = `# ${firstParsed.subject}\n\n`;
        mdContent += `**Thread ID:** ${threadId}\n`;
        mdContent += `**Message Count:** ${messages.length}\n\n---\n\n`;

        for (const msg of messages) {
            const parsed = parseMessageData(msg);
            mdContent += `### From: ${parsed.from}\n`;
            mdContent += `**Date:** ${parsed.date}\n\n`;
            mdContent += `${parsed.body}\n\n`;
            mdContent += `---\n\n`;

            const msgDate = tryParseDate(parsed.date);
            if (msgDate && (!newestDate || msgDate > newestDate)) {
                newestDate = msgDate;
            }
        }
        subjectForLog = firstParsed.subject;
    }

    fs.writeFileSync(path.join(syncDir, `${cleanFilename(threadId)}.md`), mdContent);
    console.log(`[Gmail] Synced Thread: ${subjectForLog} (${threadId})`);

    const newestIsoPlusOne = newestDate ? new Date(newestDate.getTime() + 1000).toISOString() : null;
    return { synced: { threadId, markdown: mdContent }, newestIsoPlusOne };
}

async function performSyncComposio() {
    const ATTACHMENTS_DIR = path.join(SYNC_DIR, 'attachments');
    const STATE_FILE = path.join(SYNC_DIR, 'sync_state.json');

    if (!fs.existsSync(SYNC_DIR)) fs.mkdirSync(SYNC_DIR, { recursive: true });
    if (!fs.existsSync(ATTACHMENTS_DIR)) fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

    const account = composioAccountsRepo.getAccount('gmail');
    if (!account || account.status !== 'ACTIVE') {
        console.log('[Gmail] Gmail not connected via Composio. Skipping sync.');
        return;
    }

    const connectedAccountId = account.id;

    const state = loadComposioState(STATE_FILE);
    let afterEpochSeconds: number;

    if (state) {
        afterEpochSeconds = Math.floor(new Date(state.last_sync).getTime() / 1000);
        console.log(`[Gmail] Syncing messages since ${state.last_sync}...`);
    } else {
        const pastDate = new Date();
        pastDate.setDate(pastDate.getDate() - COMPOSIO_LOOKBACK_DAYS);
        afterEpochSeconds = Math.floor(pastDate.getTime() / 1000);
        console.log(`[Gmail] First sync - fetching last ${COMPOSIO_LOOKBACK_DAYS} days...`);
    }

    let run: ServiceRunContext | null = null;
    const ensureRun = async () => {
        if (!run) {
            run = await serviceLogger.startRun({
                service: 'gmail',
                message: 'Syncing Gmail (Composio)',
                trigger: 'timer',
            });
        }
    };

    try {
        const allThreadIds: string[] = [];
        let pageToken: string | undefined;

        do {
            const params: Record<string, unknown> = {
                query: `after:${afterEpochSeconds}`,
                max_results: 20,
                user_id: 'me',
            };
            if (pageToken) {
                params.page_token = pageToken;
            }

            const result = await executeAction(
                'GMAIL_LIST_THREADS',
                {
                    connected_account_id: connectedAccountId,
                    user_id: 'crewm8-user',
                    version: 'latest',
                    arguments: params,
                }
            );

            if (!result.successful || !result.data) {
                console.error('[Gmail] Failed to list threads:', result.error);
                return;
            }

            const data = result.data as Record<string, unknown>;
            const threads = data.threads as Array<Record<string, unknown>> | undefined;

            if (threads && threads.length > 0) {
                for (const thread of threads) {
                    const threadId = thread.id as string | undefined;
                    if (threadId) {
                        allThreadIds.push(threadId);
                    }
                }
            }

            pageToken = data.nextPageToken as string | undefined;
        } while (pageToken);

        if (allThreadIds.length === 0) {
            console.log('[Gmail] No new threads.');
            return;
        }

        console.log(`[Gmail] Found ${allThreadIds.length} threads to sync.`);

        await ensureRun();
        const limitedThreads = limitEventItems(allThreadIds);
        await serviceLogger.log({
            type: 'changes_identified',
            service: run!.service,
            runId: run!.runId,
            level: 'info',
            message: `Found ${allThreadIds.length} thread${allThreadIds.length === 1 ? '' : 's'} to sync`,
            counts: { threads: allThreadIds.length },
            items: limitedThreads.items,
            truncated: limitedThreads.truncated,
        });

        // Process oldest first so high-water mark advances chronologically
        allThreadIds.reverse();

        let highWaterMark: string | null = state?.last_sync ?? null;
        let processedCount = 0;
        const synced: SyncedThread[] = [];
        for (const threadId of allThreadIds) {
            // Re-check connection in case user disconnected mid-sync
            if (!composioAccountsRepo.isConnected('gmail')) {
                console.log('[Gmail] Account disconnected during sync. Stopping.');
                break;
            }
            try {
                const result = await processThreadComposio(connectedAccountId, threadId, SYNC_DIR);
                processedCount++;

                if (result.synced) synced.push(result.synced);

                if (result.newestIsoPlusOne) {
                    if (!highWaterMark || new Date(result.newestIsoPlusOne) > new Date(highWaterMark)) {
                        highWaterMark = result.newestIsoPlusOne;
                    }
                    saveComposioState(STATE_FILE, highWaterMark);
                }
            } catch (error) {
                console.error(`[Gmail] Error processing thread ${threadId}, skipping:`, error);
            }
        }

        await publishGmailSyncEvent(synced);

        await serviceLogger.log({
            type: 'run_complete',
            service: run!.service,
            runId: run!.runId,
            level: 'info',
            message: `Gmail sync complete: ${processedCount}/${allThreadIds.length} thread${allThreadIds.length === 1 ? '' : 's'}`,
            durationMs: Date.now() - run!.startedAt,
            outcome: 'ok',
            summary: { threads: processedCount },
        });

        console.log(`[Gmail] Sync completed. Processed ${processedCount}/${allThreadIds.length} threads.`);
    } catch (error) {
        console.error('[Gmail] Error during sync:', error);
        await ensureRun();
        await serviceLogger.log({
            type: 'error',
            service: run!.service,
            runId: run!.runId,
            level: 'error',
            message: 'Gmail sync error',
            error: error instanceof Error ? error.message : String(error),
        });
        await serviceLogger.log({
            type: 'run_complete',
            service: run!.service,
            runId: run!.runId,
            level: 'error',
            message: 'Gmail sync failed',
            durationMs: Date.now() - run!.startedAt,
            outcome: 'error',
        });
    }
}

export async function init() {
    console.log("Starting Gmail Sync (TS)...");
    console.log(`Will sync every ${SYNC_INTERVAL_MS / 1000} seconds.`);

    while (true) {
        try {
            const isConnected = composioAccountsRepo.isConnected('gmail');
            if (!isConnected) {
                console.log('[Gmail] Gmail not connected via Composio. Sleeping...');
            } else {
                await performSyncComposio();
            }
        } catch (error) {
            console.error("Error in main loop:", error);
        }

        // Sleep for N minutes before next check (can be interrupted by triggerSync)
        console.log(`Sleeping for ${SYNC_INTERVAL_MS / 1000} seconds...`);
        await interruptibleSleep(SYNC_INTERVAL_MS);
    }
}
