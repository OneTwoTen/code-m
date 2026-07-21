import { readFileSync } from "node:fs";

interface PackageMetadata {
  name: string;
  version: string;
}

function readPackageMetadata(): PackageMetadata {
  const value = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as Partial<PackageMetadata>;

  if (!value.name || !value.version) {
    throw new Error("Root package metadata must include name and version.");
  }

  return { name: value.name, version: value.version };
}

export const CODEM_APPLICATION = Object.freeze(readPackageMetadata());

export function runtimeVersion(): string {
  return `Bun ${Bun.version}`;
}
