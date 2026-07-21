import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const SALT = Buffer.from("codem/github-app-secrets/v1", "utf8");
const INFO = Buffer.from("github-app-config", "utf8");

export class SecretBox {
  readonly #key: Buffer;

  constructor(secretKey: string) {
    if (secretKey.length < 24) throw new Error("CODEM_SECRET_KEY must be at least 24 characters.");
    this.#key = Buffer.from(hkdfSync("sha256", Buffer.from(secretKey, "utf8"), SALT, INFO, 32));
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  decrypt(value: string): string {
    const [version, ivValue, tagValue, ciphertextValue, extra] = value.split(".");
    if (version !== VERSION || !ivValue || !tagValue || !ciphertextValue || extra) {
      throw new Error("Encrypted secret has an invalid format.");
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        Buffer.from(ivValue, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Encrypted secret could not be authenticated.");
    }
  }
}
