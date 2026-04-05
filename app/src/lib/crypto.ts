/** E2EE helpers — pairwise X25519 + XSalsa20-Poly1305 via tweetnacl. */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

export interface KeyPair {
	publicKey: Uint8Array;
	secretKey: Uint8Array;
}

/** Generate a fresh X25519 keypair. */
export function generateKeyPair(): KeyPair {
	return nacl.box.keyPair();
}

/** Base64-encode a public key for transport. */
export function exportPublicKey(pk: Uint8Array): string {
	return encodeBase64(pk);
}

/** Decode a base64-encoded public key. */
export function importPublicKey(b64: string): Uint8Array {
	return decodeBase64(b64);
}

/**
 * Encrypt a plaintext string for a specific peer.
 * Returns a base64 string containing nonce + ciphertext.
 */
export function encrypt(
	plaintext: string,
	theirPublicKey: Uint8Array,
	mySecretKey: Uint8Array,
): string {
	const nonce = nacl.randomBytes(nacl.box.nonceLength);
	const messageBytes = decodeUTF8(plaintext);
	const ciphertext = nacl.box(messageBytes, nonce, theirPublicKey, mySecretKey);
	if (!ciphertext) throw new Error('Encryption failed');

	// Pack nonce + ciphertext into a single buffer
	const packed = new Uint8Array(nonce.length + ciphertext.length);
	packed.set(nonce);
	packed.set(ciphertext, nonce.length);
	return encodeBase64(packed);
}

/**
 * Decrypt a base64 nonce+ciphertext string from a specific peer.
 * Returns the plaintext string, or null if decryption fails.
 */
export function decrypt(
	packed: string,
	theirPublicKey: Uint8Array,
	mySecretKey: Uint8Array,
): string | null {
	const data = decodeBase64(packed);
	if (data.length <= nacl.box.nonceLength) return null;

	const nonce = data.slice(0, nacl.box.nonceLength);
	const ciphertext = data.slice(nacl.box.nonceLength);
	const plaintext = nacl.box.open(ciphertext, nonce, theirPublicKey, mySecretKey);
	if (!plaintext) return null;
	return encodeUTF8(plaintext);
}
