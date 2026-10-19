// Cifrado del payload: el AAD liga el blob a la identidad del activo, así un
// ciphertext ajeno (otro id/tipo/paciente) no desenvuelve limpio aunque su CID
// coincidiera. Un tag que no verifica sale como AuthenticationError tipado.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { encryptResource, decryptResource, assetAAD, AuthenticationError } = require('../src/crypto');

const OBJ = { resourceType: 'Observation', id: 'obs-demo-001', status: 'final' };
const AAD = assetAAD('observation-1', 'Observation', 'pac-hash');

test('round-trip con AAD devuelve el objeto original', () => {
  const { blob, aesKey } = encryptResource(OBJ, AAD);
  assert.deepEqual(decryptResource(blob, aesKey, AAD), OBJ);
});

test('round-trip sin AAD sigue funcionando (retrocompatible)', () => {
  const { blob, aesKey } = encryptResource(OBJ);
  assert.deepEqual(decryptResource(blob, aesKey), OBJ);
});

test('un AAD de otro activo no autentica', () => {
  const { blob, aesKey } = encryptResource(OBJ, AAD);
  const otro = assetAAD('observation-2', 'Observation', 'pac-hash');
  assert.throws(() => decryptResource(blob, aesKey, otro), AuthenticationError);
});

test('omitir el AAD cuando se cifró con uno no autentica', () => {
  const { blob, aesKey } = encryptResource(OBJ, AAD);
  assert.throws(() => decryptResource(blob, aesKey), AuthenticationError);
});

test('un ciphertext adulterado no autentica', () => {
  const { blob, aesKey } = encryptResource(OBJ, AAD);
  blob[blob.length - 1] ^= 0xff; // flip del último byte del ciphertext
  assert.throws(() => decryptResource(blob, aesKey, AAD), AuthenticationError);
});

test('una clave equivocada no autentica', () => {
  const { blob } = encryptResource(OBJ, AAD);
  assert.throws(() => decryptResource(blob, crypto.randomBytes(32), AAD), AuthenticationError);
});

test('AuthenticationError es tipado: code y status', () => {
  const { blob, aesKey } = encryptResource(OBJ, AAD);
  try {
    decryptResource(blob, aesKey, assetAAD('x', 'y', 'z'));
    assert.fail('debía lanzar');
  } catch (e) {
    assert.ok(e instanceof AuthenticationError);
    assert.equal(e.code, 'auth-gcm-fallida');
    assert.equal(e.status, 409);
  }
});
