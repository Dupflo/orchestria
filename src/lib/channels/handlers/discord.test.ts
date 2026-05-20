import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  verifyDiscordSignature,
  extractCommandText,
  INTERACTION_TYPE_PING,
  INTERACTION_TYPE_APPLICATION_COMMAND,
  type DiscordInteraction,
} from "./discord";

/**
 * Generate an Ed25519 keypair and a (timestamp, body, signature, publicKeyHex)
 * tuple that matches exactly what Discord sends. Verifies our SPKI-prefix
 * trick keeps round-tripping correctly.
 */
function freshSignedRequest(body: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  // Last 32 bytes of an Ed25519 SPKI = the raw public key Discord publishes.
  const rawPub = der.subarray(der.length - 32);
  const publicKeyHex = rawPub.toString("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = crypto.sign(null, Buffer.from(timestamp + body), privateKey);
  const signatureHex = sig.toString("hex");
  return { publicKeyHex, signatureHex, timestamp, body };
}

describe("verifyDiscordSignature", () => {
  it("accepts a freshly-signed payload", () => {
    const r = freshSignedRequest('{"type":1}');
    expect(verifyDiscordSignature(r.body, r.publicKeyHex, r.signatureHex, r.timestamp)).toBe(true);
  });

  it("rejects when the body is tampered with", () => {
    const r = freshSignedRequest('{"type":1}');
    expect(verifyDiscordSignature(r.body + " ", r.publicKeyHex, r.signatureHex, r.timestamp)).toBe(false);
  });

  it("rejects when the timestamp is tampered with", () => {
    const r = freshSignedRequest('{"type":1}');
    expect(verifyDiscordSignature(r.body, r.publicKeyHex, r.signatureHex, r.timestamp + "0")).toBe(false);
  });

  it("rejects when the signature comes from a different key", () => {
    const a = freshSignedRequest('{"type":1}');
    const b = freshSignedRequest('{"type":1}');
    // a's signature, b's public key
    expect(verifyDiscordSignature(a.body, b.publicKeyHex, a.signatureHex, a.timestamp)).toBe(false);
  });

  it("rejects when headers are missing or malformed", () => {
    const r = freshSignedRequest('{"type":1}');
    expect(verifyDiscordSignature(r.body, r.publicKeyHex, null, r.timestamp)).toBe(false);
    expect(verifyDiscordSignature(r.body, r.publicKeyHex, r.signatureHex, null)).toBe(false);
    expect(verifyDiscordSignature(r.body, r.publicKeyHex, "not-hex", r.timestamp)).toBe(false);
    // 64 bytes hex of zeros — well-formed but wrong
    expect(verifyDiscordSignature(r.body, r.publicKeyHex, "0".repeat(128), r.timestamp)).toBe(false);
  });

  it("rejects when the public key is the wrong length", () => {
    const r = freshSignedRequest('{"type":1}');
    expect(verifyDiscordSignature(r.body, "abcd", r.signatureHex, r.timestamp)).toBe(false);
  });
});

describe("extractCommandText", () => {
  it("concatenates every string option in order", () => {
    const interaction: DiscordInteraction = {
      type: INTERACTION_TYPE_APPLICATION_COMMAND,
      id: "1", token: "t", application_id: "a",
      data: {
        name: "ask",
        options: [
          { name: "prompt", type: 3, value: "summarize" },
          { name: "topic",  type: 3, value: "the inbox" },
        ],
      },
    };
    expect(extractCommandText(interaction)).toBe("summarize the inbox");
  });

  it("walks nested option groups (subcommands)", () => {
    const interaction: DiscordInteraction = {
      type: INTERACTION_TYPE_APPLICATION_COMMAND,
      id: "1", token: "t", application_id: "a",
      data: {
        name: "agent",
        options: [{
          name: "atlas", type: 1, // SUB_COMMAND has no value, only nested options
          options: [{ name: "prompt", type: 3, value: "explain" }],
        }],
      },
    };
    expect(extractCommandText(interaction)).toBe("explain");
  });

  it("returns an empty string when no value is provided", () => {
    const interaction: DiscordInteraction = {
      type: INTERACTION_TYPE_PING,
      id: "1", token: "t", application_id: "a",
    };
    expect(extractCommandText(interaction)).toBe("");
  });

  it("stringifies non-string values (numbers, booleans)", () => {
    const interaction: DiscordInteraction = {
      type: INTERACTION_TYPE_APPLICATION_COMMAND,
      id: "1", token: "t", application_id: "a",
      data: {
        name: "tune",
        options: [
          { name: "temperature", type: 10, value: 0.7 },
          { name: "stream",      type: 5,  value: true },
        ],
      },
    };
    expect(extractCommandText(interaction)).toBe("0.7 true");
  });
});
