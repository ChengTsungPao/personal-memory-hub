/**
 * Backup encryption & password derivation (Design Doc §6).
 *
 * - Passwords are never stored on the server, nor is the derived private key.
 * - `scryptSync` with a random 16-byte salt derives a 32-byte seed, clamped into
 *   an X25519 private scalar to compute the 32-byte public key.
 * - The server stores only: `{ salt, scryptParams, publicKey, version, updatedAt }`.
 * - Each backup archive is encrypted using an ephemeral X25519 key pair + HKDF-SHA256 +
 *   AES-256-GCM (public-key encryption: only the public key is needed at backup time).
 * - The unencrypted file header embeds the `version`, `salt`, `scryptParams`, and
 *   `ephemeralPublicKey` so that the restore CLI only needs the backup file + password
 *   (disaster recovery works even when the server database is completely gone).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scryptSync,
} from "node:crypto";

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  N: 32768,
  r: 8,
  p: 1,
};

export interface DerivedKeyMaterial {
  saltHex: string;
  scryptParams: ScryptParams;
  /** 32-byte raw X25519 public key in hex */
  publicKeyHex: string;
  /** Short SHA-256 fingerprint of the public key for the append-only audit log */
  fingerprint: string;
}

/** PKCS#8 DER prefix for a raw 32-byte X25519 private key (RFC 8410) */
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
/** SPKI DER prefix for a raw 32-byte X25519 public key (RFC 8410) */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const HEADER_MAGIC = "PMH-AGE-V1\n";

export interface BackupFileHeader {
  v: 1;
  keyVersion: number;
  saltHex: string;
  scrypt: ScryptParams;
  recipientPubHex: string;
  ephemeralPubHex: string;
  ivHex: string;
  tagHex: string;
}

function deriveX25519Seed(password: string, saltHex: string, params: ScryptParams): Buffer {
  const salt = Buffer.from(saltHex, "hex");
  const maxmem = 128 * params.N * params.r * 2;
  return scryptSync(password.normalize("NFKC"), salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem,
  });
}

function privateKeyFromSeed(seed32: Buffer) {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, seed32]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyFromRaw(raw32: Buffer) {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw32]),
    format: "der",
    type: "spki",
  });
}

function rawPublicKeyHex(pubKeyObj: ReturnType<typeof createPublicKey>): string {
  const spki = pubKeyObj.export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32).toString("hex");
}

export function publicKeyFingerprint(publicKeyHex: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKeyHex, "hex"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Derive public key + salt from a user password.
 * Never returns or persists the private seed.
 */
export function derivePublicKeyFromPassword(
  password: string,
  saltHex?: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): DerivedKeyMaterial {
  if (!password || password.length < 12) {
    throw new Error("PASSWORD_TOO_SHORT: Backup password must be at least 12 characters");
  }
  const actualSaltHex = saltHex ?? randomBytes(16).toString("hex");
  const seed = deriveX25519Seed(password, actualSaltHex, params);
  const privKey = privateKeyFromSeed(seed);
  seed.fill(0);
  const pubKey = createPublicKey(privKey);
  const publicKeyHex = rawPublicKeyHex(pubKey);
  return {
    saltHex: actualSaltHex,
    scryptParams: params,
    publicKeyHex,
    fingerprint: publicKeyFingerprint(publicKeyHex),
  };
}

/**
 * Verify whether an input password matches the stored salt + public key.
 */
export function verifyPasswordAgainstPublicKey(
  password: string,
  saltHex: string,
  publicKeyHex: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): boolean {
  if (!password) return false;
  try {
    const seed = deriveX25519Seed(password, saltHex, params);
    const privKey = privateKeyFromSeed(seed);
    seed.fill(0);
    const pubKey = createPublicKey(privKey);
    return rawPublicKeyHex(pubKey) === publicKeyHex.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Encrypt a payload buffer using ONLY the stored X25519 public key (plus salt & scrypt metadata
 * embedded in the cleartext header so standalone restore works with only the password).
 */
export function encryptBackupPayload(
  plaintext: Buffer,
  opts: {
    publicKeyHex: string;
    saltHex: string;
    scryptParams?: ScryptParams;
    keyVersion: number;
  },
): Buffer {
  const recipientPub = publicKeyFromRaw(Buffer.from(opts.publicKeyHex, "hex"));
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPubHex = rawPublicKeyHex(ephemeral.publicKey);

  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPub,
  });

  const info = Buffer.from(
    `pmh-backup-v1:${ephemeralPubHex}:${opts.publicKeyHex.toLowerCase()}`,
    "utf8",
  );
  const aesKey = Buffer.from(hkdfSync("sha256", sharedSecret, Buffer.alloc(0), info, 32));
  sharedSecret.fill(0);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  aesKey.fill(0);

  const header: BackupFileHeader = {
    v: 1,
    keyVersion: opts.keyVersion,
    saltHex: opts.saltHex,
    scrypt: opts.scryptParams ?? DEFAULT_SCRYPT_PARAMS,
    recipientPubHex: opts.publicKeyHex.toLowerCase(),
    ephemeralPubHex,
    ivHex: iv.toString("hex"),
    tagHex: tag.toString("hex"),
  };

  const headerLine = `${HEADER_MAGIC}${JSON.stringify(header)}\n`;
  return Buffer.concat([Buffer.from(headerLine, "utf8"), ciphertext]);
}

/**
 * Parse the cleartext header from an encrypted backup buffer without needing the password.
 */
export function readBackupFileHeader(encrypted: Buffer): {
  header: BackupFileHeader;
  ciphertextOffset: number;
} {
  const magicBuf = Buffer.from(HEADER_MAGIC, "utf8");
  if (
    encrypted.length <= magicBuf.length ||
    !encrypted.subarray(0, magicBuf.length).equals(magicBuf)
  ) {
    throw new Error("INVALID_BACKUP_FILE: missing PMH-AGE-V1 header");
  }
  const newlineIdx = encrypted.indexOf(0x0a, magicBuf.length);
  if (newlineIdx < 0) {
    throw new Error("INVALID_BACKUP_FILE: malformed header line");
  }
  const jsonStr = encrypted.subarray(magicBuf.length, newlineIdx).toString("utf8");
  const header = JSON.parse(jsonStr) as BackupFileHeader;
  return { header, ciphertextOffset: newlineIdx + 1 };
}

/**
 * Decrypt an encrypted backup buffer using ONLY the user password.
 */
export function decryptBackupPayload(encrypted: Buffer, password: string): {
  plaintext: Buffer;
  header: BackupFileHeader;
} {
  const { header, ciphertextOffset } = readBackupFileHeader(encrypted);
  const seed = deriveX25519Seed(password, header.saltHex, header.scrypt);
  const privKey = privateKeyFromSeed(seed);
  seed.fill(0);
  const derivedPubHex = rawPublicKeyHex(createPublicKey(privKey));
  if (derivedPubHex !== header.recipientPubHex.toLowerCase()) {
    throw new Error(
      `WRONG_PASSWORD: password does not match backup key version v${header.keyVersion}`,
    );
  }

  const ephemeralPub = publicKeyFromRaw(Buffer.from(header.ephemeralPubHex, "hex"));
  const sharedSecret = diffieHellman({
    privateKey: privKey,
    publicKey: ephemeralPub,
  });

  const info = Buffer.from(
    `pmh-backup-v1:${header.ephemeralPubHex}:${header.recipientPubHex.toLowerCase()}`,
    "utf8",
  );
  const aesKey = Buffer.from(hkdfSync("sha256", sharedSecret, Buffer.alloc(0), info, 32));
  sharedSecret.fill(0);

  const decipher = createDecipheriv(
    "aes-256-gcm",
    aesKey,
    Buffer.from(header.ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(header.tagHex, "hex"));
  const ciphertext = encrypted.subarray(ciphertextOffset);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  aesKey.fill(0);
  return { plaintext, header };
}
