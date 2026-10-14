// Verificación de integridad contra la referencia anclada en la cadena.
//
// La función se prueba con un cálculo de CID inyectado y no contra un nodo IPFS
// real: lo que hay que verificar es la lógica de contraste, es decir, qué
// discrepancias detecta y cuáles deja pasar. Que el CID se calcule bien es
// responsabilidad del nodo, y por eso se le pide a él (ver src/ipfs.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyAgainstLedger, IntegrityError } = require('../src/integrity');

const CID_REGISTRADO = 'QmReferenciaAnclada';
const CONTENIDO = Buffer.from('blob cifrado del recurso');

// Calculador de CID de prueba: devuelve el CID registrado para el contenido
// original y uno distinto para cualquier otro, que es el comportamiento que
// tendría el nodo ante contenido alterado.
const calculador = async (buf) =>
  (buf.equals(CONTENIDO) ? CID_REGISTRADO : 'QmContenidoDistinto');

const activo = {
  FhirResourceID: 'obs-1',
  IpfsCid: CID_REGISTRADO,
  OwnerOrg: 'ClinicaGenerica1MSP',
};

test('acepta el contenido que corresponde a la referencia anclada', async () => {
  const r = await verifyAgainstLedger({
    asset: activo,
    cidUsado: CID_REGISTRADO,
    blob: CONTENIDO,
    computeCID: calculador,
  });
  assert.equal(r.ok, true);
  assert.equal(r.cid, CID_REGISTRADO);
});

test('rechaza un contenido alterado aunque la referencia sea la correcta', async () => {
  // Es el caso que el cifrado autenticado no cubre: un blob distinto, pero
  // válido, descifraría sin error si nadie contrasta el CID.
  await assert.rejects(
    () => verifyAgainstLedger({
      asset: activo,
      cidUsado: CID_REGISTRADO,
      blob: Buffer.from('contenido sustituido'),
      computeCID: calculador,
    }),
    (err) => {
      assert.ok(err instanceof IntegrityError);
      assert.equal(err.code, 'contenido-alterado');
      assert.equal(err.status, 409);
      assert.equal(err.detalle.cidEnLedger, CID_REGISTRADO);
      return true;
    },
  );
});

test('rechaza una referencia local que no es la registrada en la cadena', async () => {
  // Protege contra una entrega adulterada en el servidor: el contenido podría
  // ser legítimo, pero sería el de otro activo.
  await assert.rejects(
    () => verifyAgainstLedger({
      asset: activo,
      cidUsado: 'QmReferenciaAdulterada',
      blob: CONTENIDO,
      computeCID: calculador,
    }),
    (err) => {
      assert.equal(err.code, 'cid-no-coincide-con-el-ledger');
      assert.equal(err.detalle.cidUsado, 'QmReferenciaAdulterada');
      assert.equal(err.detalle.cidEnLedger, CID_REGISTRADO);
      return true;
    },
  );
});

test('la discrepancia de referencia se detecta antes de recalcular', async () => {
  // Si el CID local ya no es el del ledger, no tiene sentido gastar el cálculo:
  // la verificación tiene que cortar ahí.
  let llamadas = 0;
  await assert.rejects(
    () => verifyAgainstLedger({
      asset: activo,
      cidUsado: 'QmOtro',
      blob: CONTENIDO,
      computeCID: async (b) => { llamadas += 1; return calculador(b); },
    }),
    { code: 'cid-no-coincide-con-el-ledger' },
  );
  assert.equal(llamadas, 0, 'no debía recalcularse el CID');
});

test('rechaza un activo que no existe o no tiene CID anclado', async () => {
  for (const asset of [null, undefined, {}, { FhirResourceID: 'obs-1' }]) {
    await assert.rejects(
      () => verifyAgainstLedger({ asset, cidUsado: CID_REGISTRADO, blob: CONTENIDO, computeCID: calculador }),
      { code: 'activo-sin-referencia' },
      `debía rechazar: ${JSON.stringify(asset)}`,
    );
  }
});

test('sin CID local se verifica igual contra el del ledger', async () => {
  // La verificación bajo demanda descarga por el CID del ledger, así que no
  // hay un CID local distinto que contrastar: la primera mitad no aplica y la
  // segunda sigue siendo obligatoria.
  const ok = await verifyAgainstLedger({
    asset: activo, cidUsado: null, blob: CONTENIDO, computeCID: calculador,
  });
  assert.equal(ok.ok, true);

  await assert.rejects(
    () => verifyAgainstLedger({
      asset: activo, cidUsado: null, blob: Buffer.from('otra cosa'), computeCID: calculador,
    }),
    { code: 'contenido-alterado' },
  );
});

test('un fallo del nodo al recalcular se propaga y no se toma por válido', async () => {
  await assert.rejects(
    () => verifyAgainstLedger({
      asset: activo,
      cidUsado: CID_REGISTRADO,
      blob: CONTENIDO,
      computeCID: async () => { throw new Error('IPFS no disponible'); },
    }),
    /IPFS no disponible/,
  );
});
