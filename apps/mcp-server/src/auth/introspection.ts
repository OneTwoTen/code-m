import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export interface IntrospectionVerifierOptions {
  introspectionUrl: URL;
  clientId: string;
  clientSecret: string;
  resource: URL;
  fetch?: typeof fetch;
}

interface IntrospectionResponse {
  active?: boolean;
  client_id?: string;
  sub?: string;
  scope?: string;
  exp?: number;
  aud?: string | string[];
  resource?: string;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) throw new UnauthorizedError();
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new UnauthorizedError();
  return token;
}

function matchesResource(response: IntrospectionResponse, expected: URL): boolean {
  const expectedValue = expected.href.replace(/\/$/, "");
  const values = [
    ...(Array.isArray(response.aud) ? response.aud : response.aud ? [response.aud] : []),
    ...(response.resource ? [response.resource] : []),
  ].map((value) => value.replace(/\/$/, ""));
  return values.length === 0 || values.includes(expectedValue);
}

export class IntrospectionAccessTokenVerifier {
  readonly #options: IntrospectionVerifierOptions;

  constructor(options: IntrospectionVerifierOptions) {
    this.#options = options;
  }

  async verify(request: Request): Promise<AuthInfo> {
    const token = bearerToken(request);
    const body = new URLSearchParams({ token, resource: this.#options.resource.href });
    const basic = btoa(`${this.#options.clientId}:${this.#options.clientSecret}`);
    const response = await (this.#options.fetch ?? fetch)(this.#options.introspectionUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) throw new UnauthorizedError("Token verification failed.");
    const result = (await response.json()) as IntrospectionResponse;
    if (!result.active) throw new UnauthorizedError("Access token is inactive.");
    if (!matchesResource(result, this.#options.resource)) {
      throw new UnauthorizedError("Access token is not intended for this resource.");
    }

    return {
      token,
      clientId: result.client_id ?? result.sub ?? "unknown-client",
      scopes: result.scope?.split(/\s+/).filter(Boolean) ?? [],
      expiresAt: result.exp,
      resource: this.#options.resource,
      extra: result.sub ? { subject: result.sub } : undefined,
    };
  }
}
