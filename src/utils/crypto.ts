import crypto from 'crypto';

export function getEncryptionKey(): Buffer {
  const rawKey = process.env.ENCRYPTION_KEY || process.env.MAILBOX_ENCRYPTION_KEY;
  if (!rawKey) {
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
      throw new Error('Server configuration error: ENCRYPTION_KEY is required in production');
    }
    return crypto.createHash('sha256').update('dev_ephemeral_key_not_for_production').digest();
  }
  const buf = Buffer.from(rawKey, 'utf8');
  if (buf.length === 32) {
    return buf;
  }
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  return crypto.createHash('sha256').update(rawKey).digest();
}

const GCM_IV_LENGTH = 12; // 96 bits - NIST SP 800-38D recommended standard for AES-GCM
const AUTH_TAG_LENGTH = 16; // 128 bits authentication tag

/**
 * Encrypts plaintext using authenticated AES-256-GCM.
 * Generates a cryptographically random 12-byte IV for every encryption call.
 * Serializes as: `<iv_hex>:<authTag_hex>:<ciphertext_hex>`.
 */
export function encrypt(text: string, keyOverride?: Buffer): string {
  if (!text) return '';
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const key = keyOverride || getEncryptionKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts authenticated AES-256-GCM ciphertext.
 * Verifies the 16-byte authentication tag before returning any plaintext.
 * Fails safely if tag is tampered, ciphertext is modified, or wrong key is used.
 */
export function decrypt(text: string, throwOnError: boolean = false, keyOverride?: Buffer): string {
  try {
    if (!text || typeof text !== 'string' || !text.includes(':')) return text;
    const parts = text.split(':');
    const key = keyOverride || getEncryptionKey();

    // 1. Authenticated AES-256-GCM format: iv (hex) : authTag (hex) : ciphertext (hex)
    if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const encryptedText = Buffer.from(parts[2], 'hex');

      if (iv.length !== 12 && iv.length !== 16) {
        throw new Error('Invalid GCM IV length');
      }
      if (authTag.length !== AUTH_TAG_LENGTH) {
        throw new Error('Invalid GCM authentication tag length');
      }

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
      return decrypted.toString('utf8');
    }

    // 2. Legacy CBC fallback for 2-part format: iv (hex) : ciphertext (hex)
    if (parts.length === 2 && parts[0] && parts[1]) {
      const iv = Buffer.from(parts[0], 'hex');
      const encryptedText = Buffer.from(parts[1], 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
      return decrypted.toString('utf8');
    }

    return text;
  } catch (err) {
    if (throwOnError) throw err;
    return '';
  }
}
