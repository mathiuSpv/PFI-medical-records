// Verificación de integridad del contenido contra la referencia registrada en
// la cadena.
//
// Qué problema resuelve. El bus guarda el contenido clínico cifrado fuera de la
// cadena y en el ledger sólo ancla su CID. Esa separación es lo que permite que
// el registro compartido sea liviano, pero deja abierta una pregunta que el
// receptor necesita responder antes de usar el dato: lo que acabo de bajar del
// almacenamiento distribuido, ¿es exactamente lo que la institución emisora
// registró?
//
// El cifrado autenticado no alcanza para responderla. AES-256-GCM detecta que
// un blob fue alterado, porque el descifrado falla, pero no dice nada sobre si
// ese blob es el que corresponde al activo: un contenido cifrado válido, pero
// distinto del emitido, se descifra sin error. Lo que ata el contenido al
// registro es el CID, y por eso hay que contrastarlo.
//
// La verificación tiene dos mitades, y las dos importan por motivos distintos:
//
//   1. El CID que se está usando para descargar es el que figura en el ledger.
//      Protege contra una referencia local adulterada: si alguien cambia el CID
//      en la cola de entregas del servidor, el receptor bajaría contenido
//      legítimo del activo equivocado.
//   2. El contenido recibido vuelve a producir ese mismo CID. Protege contra un
//      nodo de almacenamiento que devuelva algo distinto de lo que se le pidió.
//
// Sin la primera, la segunda verifica coherencia con una referencia que podría
// no ser la registrada. Sin la segunda, la primera confía en el almacenamiento.
'use strict';

class IntegrityError extends Error {
  constructor(code, message, detalle = {}) {
    super(message);
    this.name = 'IntegrityError';
    this.code = code;
    this.status = 409; // Conflict: lo recibido no concuerda con lo registrado.
    this.detalle = detalle;
  }
}

/**
 * Contrasta el contenido descargado con la referencia anclada en la cadena.
 *
 * @param {object}   args
 * @param {object}   args.asset      activo tal como está registrado en el ledger.
 * @param {string}   args.cidUsado   CID con el que efectivamente se descargó.
 * @param {Buffer}   args.blob       contenido recibido del almacenamiento.
 * @param {Function} args.computeCID (buffer) => Promise<string>. Se inyecta para
 *                                   poder verificar la lógica sin un nodo IPFS.
 * @returns {Promise<{ok: true, cid: string}>} o lanza IntegrityError.
 */
async function verifyAgainstLedger({ asset, cidUsado, blob, computeCID }) {
  if (!asset || !asset.IpfsCid) {
    throw new IntegrityError(
      'activo-sin-referencia',
      'El activo no está registrado en la cadena o no tiene CID anclado: no hay contra qué verificar.',
      { fhirResourceID: asset?.FhirResourceID ?? null },
    );
  }

  if (cidUsado && cidUsado !== asset.IpfsCid) {
    throw new IntegrityError(
      'cid-no-coincide-con-el-ledger',
      `La referencia usada para descargar no es la registrada en la cadena: se descargó «${cidUsado}» y el ledger ancla «${asset.IpfsCid}».`,
      { cidUsado, cidEnLedger: asset.IpfsCid, fhirResourceID: asset.FhirResourceID },
    );
  }

  const cidRecalculado = await computeCID(blob);
  if (cidRecalculado !== asset.IpfsCid) {
    throw new IntegrityError(
      'contenido-alterado',
      `El contenido recibido no corresponde a la referencia anclada: recalculado «${cidRecalculado}», registrado «${asset.IpfsCid}».`,
      { cidRecalculado, cidEnLedger: asset.IpfsCid, fhirResourceID: asset.FhirResourceID },
    );
  }

  return { ok: true, cid: asset.IpfsCid };
}

module.exports = { verifyAgainstLedger, IntegrityError };
