import { describe, expect, test } from "bun:test";
import { loadCodeMConfig } from "./config.ts";

const productionEnv = {
  CODEM_TRANSPORT: "http",
  CODEM_PUBLIC_URL: "https://codem.example.com",
  CODEM_SECRET_KEY: "this-is-a-long-random-secret-for-tests",
};

describe("loadCodeMConfig", () => {
  test("requires only the public URL and application secret in HTTP mode", () => {
    const config = loadCodeMConfig(productionEnv);

    expect(config.transport).toBe("http");
    if (config.transport !== "http") throw new Error("expected HTTP config");
    expect(config.publicUrl.href).toBe("https://codem.example.com/");
    expect(config.mcpUrl.href).toBe("https://codem.example.com/mcp");
    expect(config.auth.issuer.href).toBe("https://codem.example.com/");
    expect(config.auth.provider).toBe("embedded");
    expect(config.allowedHosts).toEqual(["codem.example.com"]);
    expect(config.dataDir).toBe("/data");
    expect(config.databaseUrl).toBe("file:/data/codem.sqlite");
  });

  test("derives the SQLite path from a custom data directory", () => {
    const config = loadCodeMConfig({ ...productionEnv, CODEM_DATA_DIR: "/state" });
    if (config.transport !== "http") throw new Error("expected HTTP config");
    expect(config.databaseUrl).toBe("file:/state/codem.sqlite");
  });

  test("prefers an explicit database URL", () => {
    const config = loadCodeMConfig({
      ...productionEnv,
      CODEM_DATABASE_URL: "postgresql://codem:secret@db/codem",
    });
    if (config.transport !== "http") throw new Error("expected HTTP config");
    expect(config.databaseUrl).toBe("postgresql://codem:secret@db/codem");
  });

  test("rejects non-HTTPS public URLs outside localhost", () => {
    expect(() =>
      loadCodeMConfig({ ...productionEnv, CODEM_PUBLIC_URL: "http://codem.example.com" }),
    ).toThrow("CODEM_PUBLIC_URL must use HTTPS");
  });

  test("rejects public URLs with a non-root base path", () => {
    expect(() =>
      loadCodeMConfig({ ...productionEnv, CODEM_PUBLIC_URL: "https://codem.example.com/codem" }),
    ).toThrow("CODEM_PUBLIC_URL must not include a path");
  });
});
