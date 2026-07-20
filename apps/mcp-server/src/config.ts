export type CodeMTransport = "stdio" | "http";

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

export interface CodeMHttpConfig extends CodeMBaseConfig {
  transport: "http";
  host: string;
  port: number;
  publicUrl: URL;
  allowedHosts: string[];
  auth: {
    issuer: URL;
    introspectionUrl: URL;
    clientId: string;
    clientSecret: string;
    scopes: string[];
  };
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

function parseGitHubConfig(env: Record<string, string | undefined>): GitHubAppConfig | undefined {
  const values = [
    env.GITHUB_APP_ID,
    env.GITHUB_APP_PRIVATE_KEY,
    env.GITHUB_APP_INSTALLATION_ID,
  ];
  if (values.every((value) => !value?.trim())) return undefined;

  return {
    appId: required(env, "GITHUB_APP_ID"),
    privateKey: required(env, "GITHUB_APP_PRIVATE_KEY").replaceAll("\\n", "\n"),
    installationId: required(env, "GITHUB_APP_INSTALLATION_ID"),
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
  };
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

  if (transport === "stdio") {
    return { transport, ...base };
  }

  const publicUrl = parseUrl(required(env, "CODEM_PUBLIC_URL"), "CODEM_PUBLIC_URL");
  const issuer = parseUrl(required(env, "CODEM_AUTH_ISSUER"), "CODEM_AUTH_ISSUER");
  const introspectionUrl = parseUrl(
    required(env, "CODEM_AUTH_INTROSPECTION_URL"),
    "CODEM_AUTH_INTROSPECTION_URL",
  );
  const allowedHosts = required(env, "CODEM_ALLOWED_HOSTS")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (allowedHosts.length === 0) throw new Error("CODEM_ALLOWED_HOSTS cannot be empty.");

  return {
    transport,
    ...base,
    host: env.CODEM_HTTP_HOST ?? "0.0.0.0",
    port: parsePort(env.CODEM_HTTP_PORT),
    publicUrl,
    allowedHosts,
    auth: {
      issuer,
      introspectionUrl,
      clientId: required(env, "CODEM_AUTH_CLIENT_ID"),
      clientSecret: required(env, "CODEM_AUTH_CLIENT_SECRET"),
      scopes: (env.CODEM_AUTH_SCOPES ?? "codem:read codem:execute")
        .split(/[ ,]+/)
        .filter(Boolean),
    },
    allowRemoteTerminal: parseBoolean(env.CODEM_ALLOW_REMOTE_TERMINAL, false),
  };
}
