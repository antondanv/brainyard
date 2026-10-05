import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface Page {
  html: string;
  /** CSP source for the one inline script, so nothing else can run. */
  scriptHash: string;
}

const templates = new Map<string, string>();

/**
 * A page: one static HTML file with inline CSS and JS, no build step and no CDN — the dashboard
 * (`brainyard ui`), or the app's screen (`brainyard web`).
 */
export function page(version: string, name: 'dashboard' | 'app' = 'dashboard'): Page {
  let template = templates.get(name);
  if (template === undefined) {
    template = readFileSync(new URL(`./${name}.html`, import.meta.url), 'utf8');
    templates.set(name, template);
  }
  const html = template.replaceAll('{{VERSION}}', version);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  return { html, scriptHash: `sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}` };
}

export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6d7dfc"/><circle cx="9" cy="16" r="3.2" fill="#fff"/><circle cx="16" cy="16" r="3.2" fill="#fff" fill-opacity=".8"/><circle cx="23" cy="16" r="3.2" fill="#fff" fill-opacity=".6"/></svg>`;
