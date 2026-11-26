interface FetchErrorLike {
  status?: number;
  statusText?: string;
  message?: string;
  data?: unknown;
}

const MAX_TEXT = 300;

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

/** An HTML error page (a proxy's 502) says nothing useful as text. */
function isHtml(text: string): boolean {
  return /^\s*</.test(text);
}

/**
 * A readable text for anything a request or query can reject with: Grafana's
 * fetch errors (`{ status, statusText, data: { message | error } | string }`),
 * Errors, strings. Never "[object Object]".
 */
export function errorText(error: unknown): string {
  if (typeof error === 'string') {
    return shorten(error) || 'Unknown error';
  }
  if (error === null || typeof error !== 'object') {
    return error === undefined || error === null ? 'Unknown error' : String(error);
  }
  const { status, statusText, message, data } = error as FetchErrorLike;
  const fromData =
    typeof data === 'string'
      ? isHtml(data)
        ? undefined
        : data
      : ((data as { message?: unknown; error?: unknown } | undefined)?.message ??
        (data as { error?: unknown } | undefined)?.error);
  const detail = typeof fromData === 'string' && fromData.trim() ? fromData : message;
  const code = typeof status === 'number' && status > 0 ? `${status}${statusText ? ` ${statusText}` : ''}` : undefined;
  if (detail && code) {
    return shorten(`${detail} (${code})`);
  }
  if (detail || code) {
    return shorten((detail ?? code)!);
  }
  if (status === 0 || status === -1) {
    return 'The request did not reach Grafana (network error or Grafana restarting)';
  }
  try {
    const json = JSON.stringify(error);
    return json && json !== '{}' ? shorten(json) : 'Unknown error';
  } catch {
    return 'Unknown error';
  }
}

/** Failures worth trying again: Grafana or Loki busy, restarting or briefly unreachable. */
export function isTransient(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status === 'number' && (status <= 0 || status === 429 || status === 502 || status === 503 || status === 504)
  );
}
