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
const HKDF_SALT_LENGTH = 16; // salt aleatorio por envoltura

// AuthenticationError: un tag GCM que no verifica. Es un fallo de
// AUTENTICIDAD (contenido adulterado, blob ajeno al activo, o clave/AAD que no
// corresponden), no un error de infraestructura; se tipa para distinguirlo de
// un JSON mal formado o una lectura de red fallida. status 409 como el resto de
// las violaciones de integridad (ver integrity.js).
class AuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthenticationError';
    this.code = 'auth-gcm-fallida';
    this.status = 409;
  }
}

// aad normaliza los datos de ligado a un Buffer estable. El AAD no se cifra ni
// se guarda: lo autentica el tag GCM, y quien descifra tiene que reconstruirlo
// igual o el tag no verifica. Por eso se arma a partir de valores que ambos
// extremos ya conocen (el id del recurso, su tipo, el hash del paciente).
function aad(...parts) {
  return Buffer.from(parts.join('|'), 'utf8');
}

// assetAAD liga el blob del payload a la identidad del activo: un ciphertext
// cifrado para otro activo (otro id/tipo/paciente) ya no desenvuelve limpio,
// aunque su CID coincidiera. Mueve a la capa AEAD la garantía que hoy sostiene
// integrity.js (contenido ↔ activo), como defensa en profundidad.
function assetAAD(fhirResourceID, resourceType, patientIDHash) {
  return aad('pfi:asset', fhirResourceID, resourceType, patientIDHash);
}

// keyWrapAAD liga el sobre de clave al recurso al que corresponde: una clave
// envuelta no se puede re-apuntar a otro activo.
function keyWrapAAD(fhirResourceID) {
  return aad('pfi:keywrap', fhirResourceID);
}

// encryptResource(obj, aadBuf?) -> { blob, aesKey }
// blob empaqueta iv || authTag || ciphertext en un solo Buffer, listo para
// subir a IPFS tal cual. aesKey se queda en memoria de quien cifra — nunca
// se persiste en el ledger ni en IPFS. Si se pasa aadBuf, se liga al tag GCM
// (ver assetAAD); quien descifre tiene que pasar el mismo AAD.
function encryptResource(plaintextObj, aadBuf) {
  const aesKey = crypto.randomBytes(32); // AES-256
  const iv = crypto.randomBytes(GCM_IV_LENGTH);

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  if (aadBuf) cipher.setAAD(aadBuf);
  const plaintext = Buffer.from(JSON.stringify(plaintextObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const blob = Buffer.concat([iv, authTag, ciphertext]);
  return { blob, aesKey };
}

// decryptResource(blob, aesKey, aadBuf?) -> objeto original. Debe recibir el
// mismo aadBuf con que se cifró. Un tag que no verifica (contenido adulterado,
// blob ajeno, clave o AAD equivocados) sale como AuthenticationError.
function decryptResource(blob, aesKey, aadBuf) {
  const iv = blob.subarray(0, GCM_IV_LENGTH);
  const authTag = blob.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_TAG_LENGTH);
  const ciphertext = blob.subarray(GCM_IV_LENGTH + GCM_TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  if (aadBuf) decipher.setAAD(aadBuf);
  decipher.setAuthTag(authTag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new AuthenticationError('el contenido no pudo autenticarse (tag GCM inválido)');
  }
  return JSON.parse(plaintext.toString('utf8'));
}

// wrapKeyForRecipient(aesKey, recipientCertPem) -> envoltorio serializable
// (todo base64/PEM) para "entregar" — en esta etapa la entrega en sí es un
// log simulado (paso 5), no un envío real por HTTP entre orgs.
function wrapKeyForRecipient(aesKey, recipientCertPem, aadBuf) {
  const recipientCert = new crypto.X509Certificate(recipientCertPem);
  const recipientPublicKey = recipientCert.publicKey;

  const ephemeral = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPublicKey,
  });

  // Salt aleatorio por envoltura (va en el sobre): endurece la derivación
  // frente a la reutilización del mismo secreto compartido. info sigue
  // separando el dominio de uso.
  const salt = crypto.randomBytes(HKDF_SALT_LENGTH);
  const wrappingKey = Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from('pfi-medical-records:key-wrap'), 32),
  );

  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
  if (aadBuf) cipher.setAAD(aadBuf);
  const wrappedKey = Buffer.concat([cipher.update(aesKey), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    recipientSubject: recipientCert.subject,
    ephemeralPublicKeyPem: ephemeral.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    wrappedKey: wrappedKey.toString('base64'),
  };
}

// unwrapKey(envelope, recipientPrivateKey, aadBuf?) -> aesKey. La contraparte
// de wrapKeyForRecipient: solo puede correrla quien tiene la clave privada del
// certificado que se usó para envolver. Debe recibir el mismo aadBuf. Un sobre
// anterior a esta versión no trae salt: se asume vacío (retrocompatible).
function unwrapKey(envelope, recipientPrivateKey, aadBuf) {
  const ephemeralPublicKey = crypto.createPublicKey(envelope.ephemeralPublicKeyPem);
  const sharedSecret = crypto.diffieHellman({
    privateKey: recipientPrivateKey,
    publicKey: ephemeralPublicKey,
  });

  const salt = envelope.salt ? Buffer.from(envelope.salt, 'base64') : Buffer.alloc(0);
  const wrappingKey = Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from('pfi-medical-records:key-wrap'), 32),
  );

  const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, Buffer.from(envelope.iv, 'base64'));
  if (aadBuf) decipher.setAAD(aadBuf);
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.wrappedKey, 'base64')),
      decipher.final(),
    ]);
  } catch {
    throw new AuthenticationError('el sobre de clave no pudo autenticarse (tag GCM inválido)');
  }
}

module.exports = {
  encryptResource,
  decryptResource,
  wrapKeyForRecipient,
  unwrapKey,
  assetAAD,
  keyWrapAAD,
  AuthenticationError,
};
