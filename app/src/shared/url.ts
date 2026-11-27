/**
 * Strictly restricts untrusted/user/MCP navigation URLs to `http:`, `https:`, and `about:blank`.
 * Rejects `file:`, `data:`, `javascript:`, `chrome:`, `devtools:`, etc.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'about:blank') {
    return 'about:blank';
  }

  let candidate = trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(trimmed)) {
    candidate = `http://${trimmed}`;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`Invalid URL: ${trimmed}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `Unsupported URL scheme "${parsed.protocol}" (only http:, https:, and about:blank are allowed)`,
      );
    }
    return parsed.toString();
  } else if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(trimmed)) {
    candidate = `https://${trimmed}`;
  } else {
    candidate = `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
  }

  const parsed = new URL(candidate);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}"`);
  }
  return parsed.toString();
}
