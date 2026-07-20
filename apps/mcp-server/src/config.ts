import { join } from "node:path";

export type CodeMTransport = "stdio" | "http";
export type CodeMAuthProvider = "embedded" | "external-oidc";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
  apiUrl: string;
}

export interface CodeMBaseConfig {
  transport: CodeMTransport;
  workspaceRoot: string;
  github?: GitHubAppConfig;
}

export interface CodeMStdioConfig extends CodeMBaseConfig {
  transport: "stdio";
}

export interface EmbeddedAuthConfig {
  provider: "embedded";
  issuer: URL;
  scopes: string[];
}

export interface ExternalAuthConfig {
  provider: "external-oidc";
  issuer: URL;
  introspectionUrl: URL;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

export interface CodeMHttpConfig extends CodeMBaseConfig {
  transport: "http";
  host: string;
  port: number;
  publicUrl: URL;
  mcpUrl: URL;
  allowedHosts: string[];
  secretKey: string;
  dataDir: string;
  databaseUrl: string;
  auth: EmbeddedAuthConfig | ExternalAuthConfig;
  allowRemoteTerminal: boolean;
}

export type CodeMConfig = CodeMStdioConfig | CodeMHttpConfig;

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected boolean value, received ${value}.`);
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "3000");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("CODEM_HTTP_PORT must be an integer between 1 and 65535.");
  }
  return parsed;
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
}

function parsePublicUrl(value: string): URL {
  const url = parseUrl(value, "CODEM_PUBLIC_URL");
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(localhost && url.protocol === "http:")) {
    throw new Error("CODEM_PUBLIC_URL must use HTTPS outside localhost.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "CODEM_PUBLIC_URL must not contain credentials, query parameters, or fragments.",
    );
  }
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return url;
}

function parseGitHubConfig(env: Record<string, string | undefined>): GitHubAppConfig | undefined {
  const values = [env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, env.GITHUB_APP_INSTALLATION_ID];
  if (values.every((value) => !value?.trim())) return undefined;

  return {
    appId: required(env, "GITHUB_APP_ID"),
    privateKey: required(env, "GITHUB_APP_PRIVATE_KEY").replaceAll("\\n", "\n"),
    installationId: required(env, "GITHUB_APP_INSTALLATION_ID"),
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
  };
}

function parseScopes(value: string | undefined): string[] {
  return (value ?? "codem:read codem:execute").split(/[ ,]+/).filter(Boolean);
}

export function loadCodeMConfig(
  env: Record<string, string | undefined> = process.env,
): CodeMConfig {
  const transport = (env.CODEM_TRANSPORT ?? "stdio") as CodeMTransport;
  if (transport !== "stdio" && transport !== "http") {
    throw new Error("CODEM_TRANSPORT must be stdio or http.");
  }

  const base = {
    workspaceRoot: env.CODEM_WORKSPACE_ROOT ?? process.cwd(),
    github: parseGitHubConfig(env),
  };

  if (transport === "stdio") return { transport, ...base };

  const publicUrl = parsePublicUrl(required(env, "CODEM_PUBLIC_URL"));
  const secretKey = required(env, "CODEM_SECRET_KEY");
  if (secretKey.length < 24) throw new Error("CODEM_SECRET_KEY must be at least 24 characters.");

  const dataDir = env.CODEM_DATA_DIR?.trim() || "/data";
  const databaseUrl = env.CODEM_DATABASE_URL?.trim() || `file:${join(dataDir, "codem.sqlite")}`;
  const provider = (env.CODEM_AUTH_PROVIDER?.trim() || "embedded") as CodeMAuthProvider;
  if (provider !== "embedded" && provider !== "external-oidc") {
    throw new Error("CODEM_AUTH_PROVIDER must be embedded or external-oidc.");
  }

  const scopes = parseScopes(env.CODEM_AUTH_SCOPES);
  const auth: EmbeddedAuthConfig | ExternalAuthConfig =
    provider === "embedded"
      ? { provider, issuer: publicUrl, scopes }
      : {
          provider,
          issuer: parseUrl(required(env, "CODEM_AUTH_ISSUER"), "CODEM_AUTH_ISSUER"),
          introspectionUrl: parseUrl(
            required(env, "CODEM_AUTH_INTROSPECTION_URL"),
            "CODEM_AUTH_INTROSPECTION_URL",
          ),
          clientId: required(env, "CODEM_AUTH_CLIENT_ID"),
          clientSecret: required(env, "CODEM_AUTH_CLIENT_SECRET"),
          scopes,
        };

  const configuredHosts = env.CODEM_ALLOWED_HOSTS?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return {
    transport,
    ...base,
    host: env.CODEM_HTTP_HOST ?? "0.0.0.0",
    port: parsePort(env.CODEM_HTTP_PORT),
    publicUrl,
    mcpUrl: new URL("/mcp", publicUrl),
    allowedHosts: configuredHosts?.length ? configuredHosts : [publicUrl.host],
    secretKey,
    dataDir,
    databaseUrl,
    auth,
    allowRemoteTerminal: parseBoolean(env.CODEM_ALLOW_REMOTE_TERMINAL, false),
  };
}
