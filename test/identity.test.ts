import { describe, expect, it } from "vitest";
import { DeviceIdentity } from "../src/core/identity";
import { x25519 } from "@noble/curves/ed25519";

describe("identity", () => {
  it("generates an identity", () => {
    const id = DeviceIdentity.generate("Test Desktop");
    expect(id.device_id.length).toBeGreaterThan(0);
    expect(id.device_name).toBe("Test Desktop");
    expect(id.createdAt).toBeGreaterThan(0);
    expect(id.privateKey.length).toBe(32);
    expect(id.publicKey.length).toBe(32);
  });

  it("fingerprint is 8 hex bytes (16 chars)", () => {
    const id = DeviceIdentity.generate("Test");
    expect(id.fingerprint().length).toBe(16);
  });

  it("device ids are unique", () => {
    const a = DeviceIdentity.generate("A");
    const b = DeviceIdentity.generate("B");
    expect(a.device_id).not.toBe(b.device_id);
  });

  it("public key matches private key", () => {
    const id = DeviceIdentity.generate("Test");
    const derived = x25519.getPublicKey(id.privateKey);
    expect(Buffer.from(derived).equals(Buffer.from(id.publicKey))).toBe(true);
  });

  it("uuid format is v4", () => {
    const id = DeviceIdentity.generate("Test");
    expect(id.device_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("save/load round-trip preserves identity", () => {
    const id = DeviceIdentity.generate("Test");
    const stored = id.toStored();
    const loaded = DeviceIdentity.fromStored(stored);
    expect(loaded.device_id).toBe(id.device_id);
    expect(loaded.device_name).toBe(id.device_name);
    expect(loaded.fingerprint()).toBe(id.fingerprint());
    expect(Buffer.from(loaded.privateKey).equals(Buffer.from(id.privateKey))).toBe(true);
  });
});
