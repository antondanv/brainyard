import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface Page {
  html: string;
  /** CSP source for the one inline script, so nothing else can run. */
  scriptHash: string;
}

let template: string | undefined;

/** The dashboard: one static HTML file with inline CSS and JS, no build step and no CDN. */
export function page(version: string): Page {
  template ??= readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
  const html = template.replaceAll('{{VERSION}}', version);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  return { html, scriptHash: `sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}` };
}

export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6d7dfc"/><circle cx="9" cy="16" r="3.2" fill="#fff"/><circle cx="16" cy="16" r="3.2" fill="#fff" fill-opacity=".8"/><circle cx="23" cy="16" r="3.2" fill="#fff" fill-opacity=".6"/></svg>`;
