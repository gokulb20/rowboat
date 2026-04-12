/**
 * OpenRouter internal LLM provider for Crewm8 Desktop.
 *
 * HOW TO CONFIGURE
 * ----------------
 * Create ~/.rowboat/config/openrouter.json with the following shape:
 *
 *   {
 *     "apiKey": "sk-or-v1-...",
 *     "baseURL": "https://openrouter.ai/api/v1",
 *     "default_model": "nvidia/nemotron-3-super-120b-a12b"
 *   }
 *
 * Fields:
 *   apiKey        — Required. Your OpenRouter secret key (starts with sk-or-v1-).
 *   baseURL       — Optional. Defaults to https://openrouter.ai/api/v1 if omitted.
 *   default_model — Optional. The model ID to use when no override is passed to
 *                   getOpenRouterLanguageModel(). Defaults to
 *                   "nvidia/nemotron-3-super-120b-a12b" if omitted.
 *
 * If the file is absent or apiKey is empty, getOpenRouterProvider() returns null
 * and callers fall back to the main hermes chat-wire provider transparently.
 *
 * WHY A SEPARATE PROVIDER?
 * ------------------------
 * Internal LLM features (meeting summarization, schedule classification, file
 * parsing, etc.) must NOT compete with active user conversations for hermes
 * context or use the hermes-chosen chat model. OpenRouter gives these features
 * an independent, cost-controlled LLM path.
 */

import fs from 'fs/promises';
import path from 'path';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ProviderV2 } from '@ai-sdk/provider';
import type { LanguageModel } from 'ai';
import { WorkDir } from '../config/config.js';

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

export interface OpenRouterConfig {
    apiKey: string;
    baseURL?: string;
    default_model?: string;
}

const OPENROUTER_CONFIG_PATH = path.join(WorkDir, 'config', 'openrouter.json');
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';

// ---------------------------------------------------------------------------
// Config reader
// ---------------------------------------------------------------------------

async function readOpenRouterConfig(): Promise<OpenRouterConfig | null> {
    try {
        const raw = await fs.readFile(OPENROUTER_CONFIG_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<OpenRouterConfig>;
        if (!parsed.apiKey || parsed.apiKey.trim() === '') {
            console.warn('[openrouter] config found but apiKey is empty — OpenRouter disabled');
            return null;
        }
        return {
            apiKey: parsed.apiKey.trim(),
            baseURL: parsed.baseURL ?? DEFAULT_BASE_URL,
            default_model: parsed.default_model ?? DEFAULT_MODEL,
        };
    } catch (err: unknown) {
        if (isNodeError(err) && err.code === 'ENOENT') {
            return null;
        }
        console.warn('[openrouter] failed to read config:', err instanceof Error ? err.message : err);
        return null;
    }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
    return err instanceof Error && 'code' in err;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a ProviderV2 backed by OpenRouter, or null if the config file is
 * absent or has no apiKey. Safe to call on every request — reads from disk
 * each time so hot-editing the config file is picked up without a restart.
 */
export async function getOpenRouterProvider(): Promise<ProviderV2 | null> {
    const config = await readOpenRouterConfig();
    if (!config) return null;

    console.log(`[openrouter] provider loaded, default model: ${config.default_model ?? DEFAULT_MODEL}`);

    return createOpenAICompatible({
        name: 'openrouter',
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    });
}

/**
 * Convenience wrapper. Returns a LanguageModel from the OpenRouter provider
 * using modelOverride if supplied, otherwise the default_model from config.
 * Returns null if OpenRouter is not configured.
 */
export async function getOpenRouterLanguageModel(modelOverride?: string): Promise<LanguageModel | null> {
    const config = await readOpenRouterConfig();
    if (!config) return null;

    const modelId = modelOverride ?? config.default_model ?? DEFAULT_MODEL;
    console.log(`[openrouter] language model resolved: ${modelId}`);

    const provider = createOpenAICompatible({
        name: 'openrouter',
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    });

    return provider.languageModel(modelId);
}
