import { describe, expect, it } from "vitest";
import {
  AUTH_COOKIE_PREFIX,
  authCookieNameForAuthority,
  staleAuthCookieNames,
} from "./auth-cookies.ts";

/**
 * dsh mints one browser-session cookie per Host authority (`host:port`) and
 * never retires it. The shell boots a Host on a fresh ephemeral port every
 * launch, so a long-lived Electron cookie jar accumulates one cookie per
 * launch; each adds ~230 bytes to every request to the loopback origin until
 * the Host answers 431 Request Header Fields Too Large for its longest request
 * (the concatenated client bundle). These tests pin the name derivation the
 * shell has to reproduce to prune all but the live cookie.
 */
describe("authCookieNameForAuthority", () => {
  it("reproduces the name a real Host minted for its authority", () => {
    // Captured from a live Host (base64url of sha256("127.0.0.1:45998")).
    expect(authCookieNameForAuthority("127.0.0.1:45998")).toBe(
      "dsh-auth-cGnsTmKI7XhGEcE4EUwNO6IwMqUYGGrCrtvGFirYcB4",
    );
  });

  it("changes with the port — the reason the jar grows", () => {
    expect(authCookieNameForAuthority("127.0.0.1:45998")).not.toBe(
      authCookieNameForAuthority("127.0.0.1:45999"),
    );
  });

  it("is unpadded base64url after the dsh prefix", () => {
    const name = authCookieNameForAuthority("127.0.0.1:1");
    expect(name.startsWith(AUTH_COOKIE_PREFIX)).toBe(true);
    expect(name.slice(AUTH_COOKIE_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });
});

describe("staleAuthCookieNames", () => {
  const live = authCookieNameForAuthority("127.0.0.1:58644");

  it("keeps the live authority and returns every earlier generation", () => {
    const earlier = [
      authCookieNameForAuthority("127.0.0.1:52835"),
      authCookieNameForAuthority("127.0.0.1:57186"),
    ];
    expect(staleAuthCookieNames([...earlier, live], live)).toStrictEqual(earlier);
  });

  it("is a no-op when only the live cookie is present", () => {
    expect(staleAuthCookieNames([live], live)).toStrictEqual([]);
  });

  it("leaves cookies the shell does not own alone", () => {
    expect(staleAuthCookieNames(["dsh-theme", "session", "dsh-authentication"], live)).toStrictEqual([]);
  });

  it("treats any other dsh auth cookie as stale", () => {
    expect(staleAuthCookieNames(["dsh-auth-legacy", live], live)).toStrictEqual(["dsh-auth-legacy"]);
  });
});
