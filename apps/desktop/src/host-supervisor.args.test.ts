import { describe, expect, it } from "vitest";
import { dshWebArgs } from "./host-supervisor.ts";

/**
 * Flag order is a contract with the dsh launcher, not a style choice:
 * --profile/--patch are parsed by the launcher and must precede the web app's
 * own flags, and the \`web\` alias rejects parent flags outright. A reordered
 * argv boots nothing and reads as a mysterious startup timeout.
 */
describe("dshWebArgs", () => {
  const entry = "/home/u/.dsh-desktop/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js";

  it("boots the web profile through the launcher so overlays are legal", () => {
    expect(dshWebArgs(entry)).toEqual([
      "--expose-internals",
      "--max-http-header-size=65536",
      entry,
      "--profile",
      "web",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ]);
  });

  it("passes the safe-mode overlay before the app flags", () => {
    const args = dshWebArgs(entry, "/home/u/plugin-safe-mode.patch.yml");
    expect(args).toEqual([
      "--expose-internals",
      "--max-http-header-size=65536",
      entry,
      "--profile",
      "web",
      "--patch",
      "/home/u/plugin-safe-mode.patch.yml",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ]);
    const profile = args.indexOf("--profile");
    const patch = args.indexOf("--patch");
    expect(patch).toBeGreaterThan(profile);
    expect(args.indexOf("--no-open")).toBeGreaterThan(patch);
  });

  it("omits the overlay entirely rather than pointing at a missing file", () => {
    expect(dshWebArgs(entry, undefined).includes("--patch")).toBe(false);
    expect(dshWebArgs(entry, "").includes("--patch")).toBe(false);
  });

  it("hands every node flag to node, before the dsh entry", () => {
    const args = dshWebArgs(entry);
    const entryIndex = args.indexOf(entry);
    for (const flag of ["--expose-internals", "--max-http-header-size=65536"]) {
      const at = args.indexOf(flag);
      expect(at, flag).toBeGreaterThan(-1);
      expect(at, flag).toBeLessThan(entryIndex);
    }
  });

  it("raises the request-header ceiling above a loaded plugin graph", () => {
    // Node defaults to 16 KiB. The client-bundle request carries the whole
    // plugin graph in its URL, and the jar attaches every loopback cookie to
    // it; crossing the ceiling answered that one request 431, which the
    // renderer reports as "Failed to load plugins".
    const args = dshWebArgs(entry);
    const flag = args.find((arg) => arg.startsWith("--max-http-header-size="));
    expect(Number(flag?.split("=")[1])).toBeGreaterThanOrEqual(65_536);
  });
});
