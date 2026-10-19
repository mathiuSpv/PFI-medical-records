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
const { channelReaders } = require('./readmodel');
const { NATIONAL_CHANNEL, getChannels } = require('../src/config');

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

// blockByTxId devuelve la cabecera del bloque que contiene la transacción. El
// acceso puede haber quedado en un canal provincial (same-jur) o en el nacional
// (cross-jur), así que el canal viene del access-log (_channel). Leer un bloque
// exige un peer miembro del canal: si quien pregunta no lo es, se usa un lector
// miembro (readmodel.channelReaders).
async function blockByTxId(orgKey, txId, channel = NATIONAL_CHANNEL) {
  if (!TXID_RE.test(String(txId ?? ''))) {
    throw new Error('TxID inválido: se espera un hexadecimal de 64 caracteres');
  }
  const canal = channel || NATIONAL_CHANNEL;
  if (!getChannels().includes(canal)) {
    throw new Error(`Canal desconocido: ${canal}`);
  }

  const reader = channelReaders().find((r) => r.channel === canal);
  const readerOrg = reader ? reader.orgKey : orgKey;
  const { gateway } = await getConn(readerOrg, canal);
  const qscc = gateway.getNetwork(canal).getContract('qscc');
  const bytes = await qscc.evaluateTransaction('GetBlockByTxID', canal, txId);
  const bloque = common.Block.deserializeBinary(bytes);

  const header = bloque.getHeader();
  if (!header) throw new Error('El bloque no trae cabecera');

  return {
    txId,
    canal,
    // getNumber() puede venir como número o como string: el campo es un uint64
    // y jspb lo devuelve string cuando no entra en un number seguro.
    numero: String(header.getNumber()),
    dataHash: aHex(header.getDataHash()),
    previousHash: aHex(header.getPreviousHash()),
    transacciones: bloque.getData()?.getDataList()?.length ?? 0,
  };
}

module.exports = { blockByTxId, TXID_RE };
