// Cifrado del payload clínico (AES-256-GCM) y envoltura de la clave AES para
// un destinatario identificado por su certificado X.509.
//
// Los certificados de Fabric (cryptogen) usan EC P-256, no RSA, así que no
// hay "cifrado con la clave pública" directo (RSA-OAEP). En vez de eso se
// arma un esquema tipo ECIES: ECDH efímero contra la clave pública del
// certificado del destinatario -> HKDF para derivar una clave simétrica de
// envoltura -> esa clave envuelve (AES-256-GCM) la clave AES real del
// recurso. Solo quien tenga la clave privada correspondiente al certificado
// puede repetir el ECDH y desenvolver la clave — nosotros nunca la tenemos
// (ni falta: es de la otra org).
'use strict';

const crypto = require('node:crypto');

const GCM_IV_LENGTH = 12; // 96 bits, tamaño recomendado para GCM
const GCM_TAG_LENGTH = 16; // 128 bits

// encryptResource(obj) -> { blob, aesKey }
// blob empaqueta iv || authTag || ciphertext en un solo Buffer, listo para
// subir a IPFS tal cual. aesKey se queda en memoria de quien cifra — nunca
// se persiste en el ledger ni en IPFS.
function encryptResource(plaintextObj) {
  const aesKey = crypto.randomBytes(32); // AES-256
  const iv = crypto.randomBytes(GCM_IV_LENGTH);

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const plaintext = Buffer.from(JSON.stringify(plaintextObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const blob = Buffer.concat([iv, authTag, ciphertext]);
  return { blob, aesKey };
}

// decryptResource(blob, aesKey) -> objeto original. Sirve para validar el
// pipeline completo (cifrar -> IPFS -> descargar -> descifrar) en la demo.
function decryptResource(blob, aesKey) {
  const iv = blob.subarray(0, GCM_IV_LENGTH);
  const authTag = blob.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_TAG_LENGTH);
  const ciphertext = blob.subarray(GCM_IV_LENGTH + GCM_TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

// wrapKeyForRecipient(aesKey, recipientCertPem) -> envoltorio serializable
// (todo base64/PEM) para "entregar" — en esta etapa la entrega en sí es un
// log simulado (paso 5), no un envío real por HTTP entre orgs.
function wrapKeyForRecipient(aesKey, recipientCertPem) {
  const recipientCert = new crypto.X509Certificate(recipientCertPem);
  const recipientPublicKey = recipientCert.publicKey;

  const ephemeral = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPublicKey,
  });

  const wrappingKey = Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, Buffer.alloc(0), Buffer.from('pfi-medical-records:key-wrap'), 32),
  );

  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
  const wrappedKey = Buffer.concat([cipher.update(aesKey), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    recipientSubject: recipientCert.subject,
    ephemeralPublicKeyPem: ephemeral.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    wrappedKey: wrappedKey.toString('base64'),
  };
}

// unwrapKey(envelope, recipientPrivateKey) -> aesKey. La contraparte de
// wrapKeyForRecipient: solo puede correrla quien tiene la clave privada del
// certificado que se usó para envolver. No se usa en el flujo de la demo
// (esa clave privada es de la otra org), queda documentada/testeable para
// mostrar que el esquema efectivamente es reversible.
function unwrapKey(envelope, recipientPrivateKey) {
  const ephemeralPublicKey = crypto.createPublicKey(envelope.ephemeralPublicKeyPem);
  const sharedSecret = crypto.diffieHellman({
    privateKey: recipientPrivateKey,
    publicKey: ephemeralPublicKey,
  });

  const wrappingKey = Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, Buffer.alloc(0), Buffer.from('pfi-medical-records:key-wrap'), 32),
  );

  const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.wrappedKey, 'base64')),
    decipher.final(),
  ]);
}

module.exports = { encryptResource, decryptResource, wrapKeyForRecipient, unwrapKey };
