import { x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

export interface StoredDeviceIdentity {
  device_id: string;
  device_name: string;
  private_key_hex: string;
  public_key_hex: string;
  created_at: number;
}

export class DeviceIdentity {
  private constructor(
    public device_id: string,
    public device_name: string,
    public privateKey: Uint8Array,
    public publicKey: Uint8Array,
    public createdAt: number
  ) {}

  /**
   * Port of core/src/security/identity.rs::generate. x25519 keypair via
   * `@noble/curves/ed25519` x25519 (same curve as x25519-dalek), v4 UUID via
   * `crypto.randomUUID` (matches the Rust UUID layout).
   */
  static generate(deviceName: string): DeviceIdentity {
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    return new DeviceIdentity(
      crypto.randomUUID(),
      deviceName,
      privateKey,
      publicKey,
      Date.now()
    );
  }

  /** First 8 bytes of SHA-256(public key), hex — the pairing fingerprint. */
  fingerprint(): string {
    return bytesToHex(sha256(this.publicKey).slice(0, 8));
  }

  toStored(): StoredDeviceIdentity {
    return {
      device_id: this.device_id,
      device_name: this.device_name,
      private_key_hex: bytesToHex(this.privateKey),
      public_key_hex: bytesToHex(this.publicKey),
      created_at: this.createdAt,
    };
  }

  static fromStored(data: StoredDeviceIdentity): DeviceIdentity {
    return new DeviceIdentity(
      data.device_id,
      data.device_name,
      hexToBytes(data.private_key_hex),
      hexToBytes(data.public_key_hex),
      data.created_at
    );
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function hexToBytesPublic(hex: string): Uint8Array {
  return hexToBytes(hex);
}
