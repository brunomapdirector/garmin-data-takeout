// One way to call the Personal API through the relay: at most MAX_IN_FLIGHT requests
// at a time, back off on 429 / 5xx / network errors (honouring Retry-After), refresh
// the token once on 401. A 400 means a bad request (e.g. a date range over the
// endpoint's limit) and is not retried.

import type { TokenSource } from './token';

const MAX_IN_FLIGHT = 2;
const MAX_ATTEMPTS = 7;
const MAX_WAIT_S = 120;

export class ApiError extends Error {
  constructor(public status: number, public path: string) {
    super(`Garmin answered ${status} for ${path}`);
  }
}

export type WaitHandler = (seconds: number, reason: string) => void;

export class GarminClient {
  #active = 0;
  #queue: Array<() => void> = [];

  constructor(
    private relay: string,
    private tokens: TokenSource,
    private onWait: WaitHandler = () => {},
  ) {}

  getJson<T = unknown>(path: string, query?: Record<string, string | number>): Promise<T> {
    return this.#request(path, query, async (res) => (await res.json()) as T);
  }

  getBytes(path: string, query?: Record<string, string | number>): Promise<Uint8Array> {
    return this.#request(path, query, async (res) => new Uint8Array(await res.arrayBuffer()));
  }

  async #slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= MAX_IN_FLIGHT) await new Promise<void>((r) => this.#queue.push(r));
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }

  #request<T>(path: string, query: Record<string, string | number> | undefined, read: (r: Response) => Promise<T>) {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])) : '';
    const url = `${this.relay}/api/garmin${path}${qs}`;
    return this.#slot(async () => {
      let refreshed = false;
      for (let attempt = 1; ; attempt++) {
        let res: Response | null = null;
        try {
          const token = await this.tokens.get();
          res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        } catch (e) {
          if (attempt >= MAX_ATTEMPTS) throw e;
          await this.#wait(backoff(attempt), 'Connection problem. Retrying');
          continue;
        }
        if (res.ok) return read(res);
        if (res.status === 401 && !refreshed) {
          refreshed = true;
          await this.tokens.get(true);
          continue;
        }
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
          const ra = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, MAX_WAIT_S) : backoff(attempt);
          await this.#wait(wait, res.status === 429 ? 'Garmin asked us to slow down' : 'Garmin had a hiccup');
          continue;
        }
        throw new ApiError(res.status, path);
      }
    });
  }

  async #wait(seconds: number, reason: string) {
    this.onWait(seconds, reason);
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
}

// 2, 4, 8, 16 ... seconds, capped, with up to 25 % jitter so parallel requests spread.
function backoff(attempt: number): number {
  const base = Math.min(2 ** attempt, MAX_WAIT_S);
  return Math.round(base * (1 + Math.random() * 0.25));
}
