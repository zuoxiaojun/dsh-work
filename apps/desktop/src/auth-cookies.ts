import { createHash } from "node:crypto";

/**
 * Browser-session cookie hygiene for the loopback Host origin.
 *
 * dsh authenticates the Web UI with a signed cookie per Host authority
 * (`host:port`), named `dsh-auth-<base64url sha256(authority)>` and valid for
 * 30 days. Cookies ignore ports, so every launch of this shell — which always
 * boots the Host on a fresh ephemeral port — adds another credential to the
 * same jar instead of replacing the previous one. Chromium then attaches all of
 * them to every request to `127.0.0.1`, and past ~13.6 KiB of `Cookie` header
 * the Host's request-header ceiling (Node's 16 KiB default, now raised by
 * `--max-http-header-size` in host-supervisor.ts) is exceeded by its longest
 * request — the concatenated client bundle — which comes back 431 and makes the
 * renderer report every plugin as failed to load.
 *
 * This module owns the pure half: reproducing dsh's cookie name and deciding
 * which cookies are stale. The Electron call that applies it lives in main.ts.
 */

/** Cookie-name prefix dsh uses for its browser-session credentials. */
export const AUTH_COOKIE_PREFIX = "dsh-auth-";

/**
 * Cookie name dsh mints for one canonical Host authority.
 *
 * Mirrors `cookieName()` in `@deepseek-ai/dsh-client-connection`: base64url of
 * sha256 over the authority, unpadded, behind {@link AUTH_COOKIE_PREFIX}. The
 * shell must reproduce this exactly to tell the live cookie from the corpses of
 * earlier generations.
 *
 * @param authority - canonical request authority, i.e. `host:port`.
 * @returns the cookie name that authority's Host would mint.
 */
export function authCookieNameForAuthority(authority: string): string {
  return (
    AUTH_COOKIE_PREFIX +
    createHash("sha256").update(authority).digest("base64url")
  );
}

/**
 * Names of dsh auth cookies left behind by earlier Host generations.
 *
 * Every `dsh-auth-*` cookie other than the live one is dead weight: its Host
 * process is gone and the port it names will not be reused. Non-auth cookies
 * are returned untouched by omission, so a jar shared with other features keeps
 * its state.
 *
 * @param names - cookie names as reported by the cookie jar.
 * @param liveName - the cookie name of the authority about to be loaded.
 * @returns the subset safe to delete, in input order.
 */
export function staleAuthCookieNames(
  names: readonly string[],
  liveName: string,
): string[] {
  return names.filter(
    (name) => name.startsWith(AUTH_COOKIE_PREFIX) && name !== liveName,
  );
}
