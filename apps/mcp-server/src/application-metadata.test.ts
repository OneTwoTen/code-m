import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CODEM_APPLICATION, runtimeVersion } from "./application-metadata.ts";

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

describe("application metadata", () => {
  test("uses the root package name and version", () => {
    expect(CODEM_APPLICATION).toEqual({
      name: packageJson.name,
      version: packageJson.version,
    });
  });

  test("reports the active Bun runtime", () => {
    expect(runtimeVersion()).toBe(`Bun ${Bun.version}`);
  });
});
