import { describe, expect, test } from "bun:test";
import { IntrospectionAccessTokenVerifier } from "./introspection.ts";

const resource = new URL("https://codem.example.com/mcp");

function authenticatedRequest(): Request {
  return new Request(resource, { headers: { authorization: "Bearer access-token" } });
}

function verifier(fetchFn: typeof fetch, timeoutMs = 100) {
  return new IntrospectionAccessTokenVerifier({
    introspectionUrl: new URL("https://issuer.example.com/introspect"),
    clientId: "codem",
    clientSecret: "secret",
    resource,
    fetch: fetchFn,
    timeoutMs,
  });
}

function pendingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("expected an abort signal"));
        return;
      }
      const rejectFromSignal = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal.aborted) rejectFromSignal();
      else signal.addEventListener("abort", rejectFromSignal, { once: true });
    })) as typeof fetch;
}

describe("IntrospectionAccessTokenVerifier", () => {
  test("rejects active tokens without an audience or resource claim", async () => {
    const instance = verifier(
      (async () => Response.json({ active: true, client_id: "client", scope: "codem:read" })) as typeof fetch,
    );

    await expect(instance.verify(authenticatedRequest())).rejects.toThrow(
      "Access token is not intended for this resource.",
    );
  });

  test("accepts a matching audience", async () => {
    const instance = verifier(
      (async () =>
        Response.json({
          active: true,
          client_id: "client",
          scope: "codem:read",
          aud: [resource.href],
        })) as typeof fetch,
    );

    const result = await instance.verify(authenticatedRequest());
    expect(result.clientId).toBe("client");
    expect(result.scopes).toEqual(["codem:read"]);
  });

  test("returns a safe error when introspection times out", async () => {
    const instance = verifier(pendingFetch(), 5);

    await expect(instance.verify(authenticatedRequest())).rejects.toThrow(
      "Token verification timed out.",
    );
  });
});
