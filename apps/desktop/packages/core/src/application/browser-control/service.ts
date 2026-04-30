import type { BrowserControlInput, BrowserControlResult } from '@crewm8/shared/dist/browser-control.js';

export interface IBrowserControlService {
  execute(
    input: BrowserControlInput,
    ctx?: { signal?: AbortSignal },
  ): Promise<BrowserControlResult>;
}
