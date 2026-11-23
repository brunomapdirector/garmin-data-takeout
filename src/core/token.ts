// Holds the Personal API key for one session and turns it into access tokens.
// The key lives only in a private field of this object; `forget()` drops it.
// It is sent once per token (every 24 h at most), never anywhere else.

export class KeyRejectedError extends Error {
  constructor(public status: number) {
    super(
      status === 400 || status === 401 || status === 403
        ? 'Garmin did not accept this key. Check that you copied all of it and that it has not expired or been deleted.'
        : `Garmin's token service answered ${status}. Try again in a minute.`,
    );
  }
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function jwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')));
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export class TokenSource {
  #key: string | null;
  #token: string | null = null;
  #expiresAt = 0;
  #pending: Promise<string> | null = null;

  constructor(private relay: string, key: string) {
    this.#key = key.trim();
  }

  /** When the current token expires (ms since epoch), or 0 before the first exchange. */
  get expiresAt() {
    return this.#expiresAt;
  }

  async get(force = false): Promise<string> {
    if (!force && this.#token && Date.now() < this.#expiresAt - REFRESH_MARGIN_MS) return this.#token;
    this.#pending ??= this.#exchange().finally(() => (this.#pending = null));
    return this.#pending;
  }

  async #exchange(): Promise<string> {
    if (!this.#key) throw new Error('The key has been cleared. Paste it again to continue.');
    const res = await fetch(`${this.relay}/api/token`, {
      method: 'POST',
      headers: { Authorization: `ApiKey ${this.#key}` },
    });
    if (!res.ok) throw new KeyRejectedError(res.status);
    // Garmin returns the token as plain text (a JWT). Accept JSON too, in case that changes.
    let token = (await res.text()).trim();
    if (token.startsWith('{')) {
      const j = JSON.parse(token);
      token = j.access_token ?? j.accessToken ?? j.token ?? '';
    }
    token = token.replace(/^"|"$/g, '');
    if (!token) throw new KeyRejectedError(res.status);
    this.#token = token;
    this.#expiresAt = jwtExpiry(token) ?? Date.now() + 24 * 3600 * 1000;
    return token;
  }

  forget() {
    this.#key = null;
    this.#token = null;
    this.#expiresAt = 0;
  }
}
