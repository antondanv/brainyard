/**
 * Secret redaction for the human feed. An agent happily prints a token it
 * found in `.env`, and a feed ends up in logs, chats and screenshots.
 *
 * Summaries are redacted before they leave Brainyard. Full texts, tool inputs
 * and raw events are not: they are the data you asked for, and silently
 * editing them would be worse. Call `redact()` yourself before storing them.
 */

export const MASK = '***';

// Values recognised by their shape, whatever they are called.
const VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI and look-alikes
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g, // Google
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  // Telegram bot token. No `\b` on the left on purpose: it travels inside URLs
  // (`api.telegram.org/bot<token>/sendMessage`), where there is no word boundary.
  /\d{6,}:[A-Za-z0-9_-]{30,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

// Forms where only the secret half goes: a connection string without its
// host is no longer a diagnosis.
const PARTIAL_PATTERNS: readonly [RegExp, string][] = [
  [/([a-zA-Z][\w+.-]*:\/\/)([^/\s:@]{0,64}):[^/\s@]{1,256}@/g, `$1$2:${MASK}@`],
  // `API_KEY=...`, `token: ...` — the key is named and the value is next to
  // it. Eight characters keep prose ("token: none") readable.
  [
    /\b([a-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key))(\s*[=:]\s*["']?)[A-Za-z0-9_\-./+]{8,}/gi,
    `$1$2${MASK}`,
  ],
];

/** Masks anything that looks like a credential. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of VALUE_PATTERNS) out = out.replace(pattern, MASK);
  for (const [pattern, replacement] of PARTIAL_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** `jane.doe@example.com` → `j******e@example.com`: recognisable to you, useless to a scraper. */
export function maskEmail(value: string): string {
  return value.replace(/([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)([A-Za-z0-9._%+-])@/g, (_m, first, middle, last) => {
    return `${first}${'*'.repeat(Math.max(1, String(middle).length))}${last}@`;
  });
}
