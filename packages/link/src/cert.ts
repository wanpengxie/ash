/**
 * A self-signed X.509 certificate for a P-256 key, for TLS between the hub and a device (docs/LINK-E2E.md §3). Nobody checks
 * the certificate as such: both ends compare the public key inside it with the one they expect, as SSH does with host keys. So
 * the certificate is the smallest one OpenSSL takes: version 3, a random serial, `CN=ash` as issuer and subject, a validity
 * from 2020 to 2049 and the key. This file only encodes (DER); the signature is `node:crypto`'s.
 */
import { createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";

const length = (n: number): Buffer => n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), length(body.length), body]);
const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const oid = (hex: string): Buffer => tlv(0x06, Buffer.from(hex, "hex"));

/** AlgorithmIdentifier ecdsa-with-SHA256 (1.2.840.10045.4.3.2). */
const ECDSA_SHA256 = sequence(oid("2a8648ce3d040302"));
/** Name `CN=ash` (2.5.4.3, UTF8String). */
const NAME = sequence(tlv(0x31, sequence(oid("550403"), tlv(0x0c, Buffer.from("ash")))));
const VALIDITY = sequence(tlv(0x17, Buffer.from("200101000000Z")), tlv(0x17, Buffer.from("491231235959Z")));

/** PEM of a self-signed certificate for [privateKey] (ECDSA P-256). */
export function selfSignedCertificate(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40; // positive, and no leading zero byte needed
  const tbs = sequence(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), ECDSA_SHA256, NAME, VALIDITY, NAME, spki);
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const der = sequence(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}
