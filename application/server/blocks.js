// Consulta de bloques del ledger por TxID.
//
// Fabric expone esto en el system chaincode qscc, que ya se usa en health.js
// para leer la altura de los canales. Acá se pide el bloque completo que
// contiene una transacción y se devuelve solo su cabecera más el conteo de
// transacciones: es lo que hace falta para mostrar en qué bloque quedó
// asentado un acceso, sin arrastrar los payloads de todas las transacciones
// del bloque a la UI.
'use strict';

const { common } = require('@hyperledger/fabric-protos');

const { getConn } = require('./connections');
const { CHANNEL_NAME } = require('../src/config');

// El TxID de Fabric es un SHA-256 en hexadecimal. Se valida antes de consultar
// para fallar con un mensaje claro en vez de con un error de gRPC, y para no
// mandar basura al peer.
const TXID_RE = /^[0-9a-f]{64}$/i;

const aHex = (valor) => {
  if (!valor) return '';
  // getDataHash() devuelve string base64 o Uint8Array según cómo se haya
  // deserializado; se contemplan los dos.
  const bytes = typeof valor === 'string' ? Buffer.from(valor, 'base64') : Buffer.from(valor);
  return bytes.toString('hex');
};

// blockByTxId devuelve la cabecera del bloque que contiene la transacción.
async function blockByTxId(orgKey, txId) {
  if (!TXID_RE.test(String(txId ?? ''))) {
    throw new Error('TxID inválido: se espera un hexadecimal de 64 caracteres');
  }

  const { gateway } = await getConn(orgKey);
  const qscc = gateway.getNetwork(CHANNEL_NAME).getContract('qscc');
  const bytes = await qscc.evaluateTransaction('GetBlockByTxID', CHANNEL_NAME, txId);
  const bloque = common.Block.deserializeBinary(bytes);

  const header = bloque.getHeader();
  if (!header) throw new Error('El bloque no trae cabecera');

  return {
    txId,
    canal: CHANNEL_NAME,
    // getNumber() puede venir como número o como string: el campo es un uint64
    // y jspb lo devuelve string cuando no entra en un number seguro.
    numero: String(header.getNumber()),
    dataHash: aHex(header.getDataHash()),
    previousHash: aHex(header.getPreviousHash()),
    transacciones: bloque.getData()?.getDataList()?.length ?? 0,
  };
}

module.exports = { blockByTxId, TXID_RE };
