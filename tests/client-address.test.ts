import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
// Runs before the server (the Dockerfile's CMD) and decides which address the rate limits
// and the duplicate-ballot flags see.
import { clientAddress, install } from "../scripts/client-address.mjs";

describe("the client address", () => {
  it("is the connection's own address unless proxies are trusted; what a client claims is ignored", () => {
    expect(clientAddress(undefined, "10.0.0.9", 0)).toBe("10.0.0.9");
    expect(clientAddress("6.6.6.6", "10.0.0.9", 0)).toBe("10.0.0.9");
    expect(clientAddress("6.6.6.6, 7.7.7.7", "10.0.0.9", 0)).toBe("10.0.0.9");
  });

  it("with n trusted proxies, is the address the outermost of them saw", () => {
    expect(clientAddress("203.0.113.7", "10.0.0.2", 1)).toBe("203.0.113.7");
    expect(clientAddress("6.6.6.6, 203.0.113.7", "10.0.0.2", 1)).toBe("203.0.113.7"); // a forged entry left of the proxy's own
    expect(clientAddress("6.6.6.6, 203.0.113.7, 10.0.0.3", "10.0.0.2", 2)).toBe("203.0.113.7");
    expect(clientAddress(undefined, "10.0.0.2", 1)).toBe("10.0.0.2"); // no header after all: the socket
    expect(clientAddress("1.1.1.1", "10.0.0.2", Number.NaN)).toBe("10.0.0.2"); // a nonsense setting trusts nobody
  });

  describe("on a real server", () => {
    let undo: (() => void) | null = null;
    afterEach(() => {
      undo?.();
      undo = null;
    });

    const echo = () =>
      new Promise<http.Server>((resolve) => {
        const server = http.createServer((req, res) =>
          res.end(JSON.stringify({ xff: req.headers["x-forwarded-for"] ?? null, real: req.headers["x-real-ip"] ?? null })),
        );
        server.listen(0, "127.0.0.1", () => resolve(server));
      });
    const ask = async (server: http.Server) => {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" } });
      return (await res.json()) as { xff: string | null; real: string | null };
    };

    it("rewrites what a client claims to the socket's address (control: without it the claim gets through)", async () => {
      const server = await echo();
      try {
        expect(await ask(server)).toEqual({ xff: "6.6.6.6", real: "7.7.7.7" });
        undo = install(http, 0);
        const seen = await ask(server);
        expect(seen.real).toBeNull();
        expect(seen.xff).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });
  });
});
