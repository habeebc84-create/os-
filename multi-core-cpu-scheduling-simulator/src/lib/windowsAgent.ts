export const LOCAL_DASHBOARD_URL = 'http://127.0.0.1:8080/';

type AgentRequest = RequestInit & { targetAddressSpace?: 'loopback' };

export interface HardwareInfo {
  cpuModel: string;
  physicalCores: number;
  logicalProcessors: number;
  affinityCores?: number[];
}

export interface LiveMetrics {
  cpuPercent: number;
  ramPercent: number;
  ramUsedMB: number;
  ramTotalMB: number;
}

export interface LaunchResult {
  launched: boolean;
  pid: number;
  pinnedCore: number;
  message: string;
}

function getBackendUrl(): URL {
  try {
    const url = new URL(import.meta.env.VITE_BACKEND_URL?.trim() || LOCAL_DASHBOARD_URL);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url;
  } catch {
    // Fall back to the standard loopback address.
  }
  return new URL(LOCAL_DASHBOARD_URL);
}

const backendUrl = getBackendUrl();
const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(backendUrl.hostname);
export const canConnectToAgent =
  window.location.protocol === 'http:' || backendUrl.protocol === 'https:' || isLoopback;

export async function fetchWithTimeout<T>(
  url: string,
  options: AgentRequest,
  timeoutMs: number,
  readResponse: (response: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abort = () => controller.abort();
  if (externalSignal?.aborted) abort();
  externalSignal?.addEventListener('abort', abort, { once: true });

  const timer = window.setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return await readResponse(response);
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
}

export async function requestAgent<T>(path: string, options: RequestInit = {}, timeout = 2500): Promise<T> {
  const request: AgentRequest = { ...options, credentials: 'omit', cache: 'no-store', redirect: 'error' };
  if (window.location.protocol === 'https:' && backendUrl.protocol === 'http:' && isLoopback) {
    request.targetAddressSpace = 'loopback';
  }

  return fetchWithTimeout(new URL(path, backendUrl).href, request, timeout, async (response) => {
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.message || data?.error || `Windows agent request failed (HTTP ${response.status}).`);
    }
    return data as T;
  });
}
