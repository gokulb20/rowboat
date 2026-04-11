// API_URL was previously a Rowboat Labs managed gateway fallback. In the
// Crewm8 gateway model the client talks directly to a user-configured
// remote agent (e.g. hermes on Mac Mini over Tailscale) via models.json,
// so this default is empty and any code that still references API_URL
// should gracefully degrade when it's unset.
export const API_URL = process.env.API_URL || '';