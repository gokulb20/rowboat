import fs from 'fs';
import path from 'path';
import { WorkDir } from '../config/config.js';
import { serviceLogger, type ServiceRunContext } from '../services/service_logger.js';
import { limitEventItems } from './limit_event_items.js';
import { executeAction } from '../composio/client.js';
import { composioAccountsRepo } from '../composio/repo.js';
import { createEvent } from './track/events.js';

const MAX_EVENTS_IN_DIGEST = 50;
const MAX_DESCRIPTION_CHARS = 500;

type AnyEvent = Record<string, unknown>;

function getStr(obj: unknown, key: string): string | undefined {
    if (obj && typeof obj === 'object' && key in obj) {
        const v = (obj as Record<string, unknown>)[key];
        return typeof v === 'string' ? v : undefined;
    }
    return undefined;
}

function formatEventTime(event: AnyEvent): string {
    const start = (event as Record<string, unknown>).start as Record<string, unknown> | undefined;
    const end = (event as Record<string, unknown>).end as Record<string, unknown> | undefined;
    const startStr = getStr(start, 'dateTime') ?? getStr(start, 'date') ?? 'unknown';
    const endStr = getStr(end, 'dateTime') ?? getStr(end, 'date') ?? 'unknown';
    return `${startStr} → ${endStr}`;
}

function formatEventBlock(event: AnyEvent, label: 'NEW' | 'UPDATED'): string {
    const id = getStr(event, 'id') ?? '(unknown id)';
    const title = getStr(event, 'summary') ?? '(no title)';
    const time = formatEventTime(event);
    const organizer = getStr((event as Record<string, unknown>).organizer, 'email') ?? 'unknown';
    const location = getStr(event, 'location') ?? '';
    const rawDescription = getStr(event, 'description') ?? '';
    const description = rawDescription.length > MAX_DESCRIPTION_CHARS
        ? rawDescription.slice(0, MAX_DESCRIPTION_CHARS) + '…(truncated)'
        : rawDescription;

    const attendeesRaw = (event as Record<string, unknown>).attendees;
    let attendeesLine = '';
    if (Array.isArray(attendeesRaw) && attendeesRaw.length > 0) {
        const emails = attendeesRaw
            .map(a => getStr(a, 'email'))
            .filter((e): e is string => !!e);
        if (emails.length > 0) {
            attendeesLine = `**Attendees:** ${emails.join(', ')}\n`;
        }
    }

    return [
        `### [${label}] ${title}`,
        `**ID:** ${id}`,
        `**Time:** ${time}`,
        `**Organizer:** ${organizer}`,
        location ? `**Location:** ${location}` : '',
        attendeesLine.trimEnd(),
        description ? `\n${description}` : '',
    ].filter(Boolean).join('\n');
}

function summarizeCalendarSync(
    newEvents: AnyEvent[],
    updatedEvents: AnyEvent[],
    deletedEventIds: string[],
): string {
    const totalChanges = newEvents.length + updatedEvents.length + deletedEventIds.length;
    const lines: string[] = [
        `# Calendar sync update`,
        ``,
        `${newEvents.length} new, ${updatedEvents.length} updated, ${deletedEventIds.length} deleted.`,
        ``,
    ];

    const allChanges: Array<{ event: AnyEvent; label: 'NEW' | 'UPDATED' }> = [
        ...newEvents.map(e => ({ event: e, label: 'NEW' as const })),
        ...updatedEvents.map(e => ({ event: e, label: 'UPDATED' as const })),
    ];

    const shown = allChanges.slice(0, MAX_EVENTS_IN_DIGEST);
    const hidden = allChanges.length - shown.length;

    if (shown.length > 0) {
        lines.push(`## Changed events`, ``);
        for (const { event, label } of shown) {
            lines.push(formatEventBlock(event, label), ``);
        }
        if (hidden > 0) {
            lines.push(`_…and ${hidden} more change(s) omitted from digest._`, ``);
        }
    }

    if (deletedEventIds.length > 0) {
        lines.push(`## Deleted event IDs`, ``);
        for (const id of deletedEventIds.slice(0, MAX_EVENTS_IN_DIGEST)) {
            lines.push(`- ${id}`);
        }
        if (deletedEventIds.length > MAX_EVENTS_IN_DIGEST) {
            lines.push(`- _…and ${deletedEventIds.length - MAX_EVENTS_IN_DIGEST} more_`);
        }
        lines.push(``);
    }

    if (totalChanges === 0) {
        lines.push(`(no changes — should not be emitted)`);
    }

    return lines.join('\n');
}

async function publishCalendarSyncEvent(
    newEvents: AnyEvent[],
    updatedEvents: AnyEvent[],
    deletedEventIds: string[],
): Promise<void> {
    if (newEvents.length === 0 && updatedEvents.length === 0 && deletedEventIds.length === 0) {
        return;
    }
    try {
        await createEvent({
            source: 'calendar',
            type: 'calendar.synced',
            createdAt: new Date().toISOString(),
            payload: summarizeCalendarSync(newEvents, updatedEvents, deletedEventIds),
        });
    } catch (err) {
        console.error('[Calendar] Failed to publish sync event:', err);
    }
}

// Configuration
const SYNC_DIR = path.join(WorkDir, 'calendar_sync');
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const COMPOSIO_LOOKBACK_DAYS = 7;

// --- Wake Signal for Immediate Sync Trigger ---
let wakeResolve: (() => void) | null = null;

export function triggerSync(): void {
    if (wakeResolve) {
        console.log('[Calendar] Triggered - waking up immediately');
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

// --- Sync Logic ---

function cleanUpOldFiles(currentEventIds: Set<string>, syncDir: string): string[] {
    if (!fs.existsSync(syncDir)) return [];

    const files = fs.readdirSync(syncDir);
    const deleted: string[] = [];
    for (const filename of files) {
        if (filename === 'sync_state.json' || filename === 'composio_state.json') continue;

        // We expect files like:
        // {eventId}.json
        // {eventId}_doc_{docId}.md

        let eventId: string | null = null;

        if (filename.endsWith('.json')) {
            eventId = filename.replace('.json', '');
        } else if (filename.endsWith('.md')) {
            // Try to extract eventId from prefix
            // Assuming eventId doesn't contain underscores usually, but if it does, this split might be fragile.
            // Google Calendar IDs are usually alphanumeric.
            // Let's rely on the delimiter we use: "_doc_"
            const parts = filename.split('_doc_');
            if (parts.length > 1) {
                eventId = parts[0];
            }
        }

        if (eventId && !currentEventIds.has(eventId)) {
            try {
                fs.unlinkSync(path.join(syncDir, filename));
                console.log(`Removed old/out-of-window file: ${filename}`);
                deleted.push(filename);
            } catch (e) {
                console.error(`Error deleting file ${filename}:`, e);
            }
        }
    }
    return deleted;
}

// --- Composio-based Sync ---

function saveComposioState(stateFile: string, lastSync: string): void {
    fs.writeFileSync(stateFile, JSON.stringify({ last_sync: lastSync }, null, 2));
}

/**
 * Save a Composio calendar event as JSON (same format used by Google OAuth path).
 * The event data from Composio is already structured similarly to Google Calendar API.
 */
function saveComposioEvent(eventData: Record<string, unknown>, syncDir: string): { changed: boolean; isNew: boolean; title: string } {
    const eventId = eventData.id as string | undefined;
    if (!eventId) return { changed: false, isNew: false, title: 'Unknown' };

    const filePath = path.join(syncDir, `${eventId}.json`);
    const content = JSON.stringify(eventData, null, 2);
    const exists = fs.existsSync(filePath);

    try {
        if (exists) {
            const existing = fs.readFileSync(filePath, 'utf-8');
            if (existing === content) {
                return { changed: false, isNew: false, title: (eventData.summary as string) || eventId };
            }
        }

        fs.writeFileSync(filePath, content);
        return { changed: true, isNew: !exists, title: (eventData.summary as string) || eventId };
    } catch (e) {
        console.error(`[Calendar] Error saving event ${eventId}:`, e);
        return { changed: false, isNew: false, title: (eventData.summary as string) || eventId };
    }
}

async function performSyncComposio() {
    const STATE_FILE = path.join(SYNC_DIR, 'composio_state.json');

    if (!fs.existsSync(SYNC_DIR)) fs.mkdirSync(SYNC_DIR, { recursive: true });

    const account = composioAccountsRepo.getAccount('googlecalendar');
    if (!account || account.status !== 'ACTIVE') {
        console.log('[Calendar] Google Calendar not connected via Composio. Skipping sync.');
        return;
    }

    const connectedAccountId = account.id;

    // Calculate time window: lookback + 14 days forward
    const now = new Date();
    const lookbackMs = COMPOSIO_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const twoWeeksForwardMs = 14 * 24 * 60 * 60 * 1000;

    const timeMin = new Date(now.getTime() - lookbackMs).toISOString();
    const timeMax = new Date(now.getTime() + twoWeeksForwardMs).toISOString();

    console.log(`[Calendar] Syncing via Composio from ${timeMin} to ${timeMax} (lookback: ${COMPOSIO_LOOKBACK_DAYS} days)...`);

    let run: ServiceRunContext | null = null;
    const ensureRun = async (): Promise<ServiceRunContext> => {
        if (!run) {
            run = await serviceLogger.startRun({
                service: 'calendar',
                message: 'Syncing calendar (Composio)',
                trigger: 'timer',
            });
        }
        return run;
    };

    try {
        const currentEventIds = new Set<string>();
        let newCount = 0;
        let updatedCount = 0;
        const changedTitles: string[] = [];
        const newEvents: AnyEvent[] = [];
        const updatedEvents: AnyEvent[] = [];
        let pageToken: string | null = null;
        const MAX_PAGES = 20;

        for (let page = 0; page < MAX_PAGES; page++) {
            // Re-check connection in case user disconnected mid-sync
            if (!composioAccountsRepo.isConnected('googlecalendar')) {
                console.log('[Calendar] Account disconnected during sync. Stopping.');
                return;
            }

            const args: Record<string, unknown> = {
                calendar_id: 'primary',
                time_min: timeMin,
                time_max: timeMax,
                single_events: true,
                order_by: 'startTime',
            };
            if (pageToken) {
                args.page_token = pageToken;
            }

            const result = await executeAction(
                'GOOGLECALENDAR_FIND_EVENT',
                {
                    connected_account_id: connectedAccountId,
                    user_id: 'crewm8-user',
                    version: 'latest',
                    arguments: args,
                }
            );

            if (!result.successful || !result.data) {
                console.error('[Calendar] Failed to list events via Composio:', result.error);
                return;
            }

            const data = result.data as Record<string, unknown>;
            // Composio may return events in different structures
            let events: Array<Record<string, unknown>> = [];

            if (Array.isArray(data.items)) {
                events = data.items as Array<Record<string, unknown>>;
            } else if (Array.isArray(data.events)) {
                events = data.events as Array<Record<string, unknown>>;
            } else if (data.event_data && typeof data.event_data === 'object') {
                const nested = data.event_data as Record<string, unknown>;
                if (Array.isArray(nested.event_data)) {
                    events = nested.event_data as Array<Record<string, unknown>>;
                } else if (Array.isArray(data.event_data)) {
                    events = data.event_data as Array<Record<string, unknown>>;
                }
            } else if (Array.isArray(data)) {
                events = data as unknown as Array<Record<string, unknown>>;
            }

            if (events.length === 0 && page === 0) {
                console.log('[Calendar] No events found in this window.');
            } else if (events.length > 0) {
                console.log(`[Calendar] Page ${page + 1}: found ${events.length} events.`);
                for (const event of events) {
                    const eventId = event.id as string | undefined;
                    if (eventId) {
                        const saveResult = saveComposioEvent(event, SYNC_DIR);
                        currentEventIds.add(eventId);

                        if (saveResult.changed) {
                            await ensureRun();
                            changedTitles.push(saveResult.title);
                            if (saveResult.isNew) {
                                newCount++;
                                newEvents.push(event);
                            } else {
                                updatedCount++;
                                updatedEvents.push(event);
                            }
                        }
                    }
                }
            }

            // Check for next page
            const nextToken = data.nextPageToken as string | undefined;
            if (nextToken) {
                pageToken = nextToken;
                console.log(`[Calendar] Fetching next page...`);
            } else {
                break;
            }
        }

        // Clean up events no longer in the window
        const deletedFiles = cleanUpOldFiles(currentEventIds, SYNC_DIR);
        let deletedCount = 0;
        if (deletedFiles.length > 0) {
            await ensureRun();
            deletedCount = deletedFiles.length;
        }

        // Publish a single bundled event capturing all changes from this sync.
        await publishCalendarSyncEvent(newEvents, updatedEvents, deletedFiles);

        // Log results if any changes were detected (run was started by ensureRun)
        if (run) {
            const r = run as ServiceRunContext;
            const totalChanges = newCount + updatedCount + deletedCount;
            const limitedTitles = limitEventItems(changedTitles);
            await serviceLogger.log({
                type: 'changes_identified',
                service: r.service,
                runId: r.runId,
                level: 'info',
                message: `Calendar updates: ${totalChanges} change${totalChanges === 1 ? '' : 's'}`,
                counts: {
                    newEvents: newCount,
                    updatedEvents: updatedCount,
                    deletedFiles: deletedCount,
                },
                items: limitedTitles.items,
                truncated: limitedTitles.truncated,
            });
            await serviceLogger.log({
                type: 'run_complete',
                service: r.service,
                runId: r.runId,
                level: 'info',
                message: `Calendar sync complete: ${totalChanges} change${totalChanges === 1 ? '' : 's'}`,
                durationMs: Date.now() - r.startedAt,
                outcome: 'ok',
                summary: {
                    newEvents: newCount,
                    updatedEvents: updatedCount,
                    deletedFiles: deletedCount,
                },
            });
        }

        // Save state
        saveComposioState(STATE_FILE, new Date().toISOString());
        console.log(`[Calendar] Composio sync completed. ${newCount} new, ${updatedCount} updated, ${deletedCount} deleted.`);
    } catch (error) {
        console.error('[Calendar] Error during Composio sync:', error);
        const errRun = await ensureRun();
        await serviceLogger.log({
            type: 'error',
            service: errRun.service,
            runId: errRun.runId,
            level: 'error',
            message: 'Calendar sync error',
            error: error instanceof Error ? error.message : String(error),
        });
        await serviceLogger.log({
            type: 'run_complete',
            service: errRun.service,
            runId: errRun.runId,
            level: 'error',
            message: 'Calendar sync failed',
            durationMs: Date.now() - errRun.startedAt,
            outcome: 'error',
        });
    }
}

export async function init() {
    console.log("Starting Google Calendar & Notes Sync (TS)...");
    console.log(`Will sync every ${SYNC_INTERVAL_MS / 1000} seconds.`);

    while (true) {
        try {
            const isConnected = composioAccountsRepo.isConnected('googlecalendar');
            if (!isConnected) {
                console.log('[Calendar] Google Calendar not connected via Composio. Sleeping...');
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
