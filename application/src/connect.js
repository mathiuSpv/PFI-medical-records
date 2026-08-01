// Conexión Gateway por org: gRPC + identidad MSP + firma, siguiendo el mismo
// patrón que fabric-samples/*/application-gateway-javascript. El servicio de
// discovery del peer conectado resuelve solo el endorsement cross-org (no
// hace falta apuntar manualmente a los peers de las otras orgs, a diferencia
// del CLI `peer chaincode invoke --peerAddresses ...` usado en el paso 3).
'use strict';

const grpc = require('@grpc/grpc-js');
const { connect, hash, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { paths } = require('./config');

async function firstFile(dirPath) {
  const files = await fs.readdir(dirPath);
  if (files.length === 0) {
    throw new Error(`No hay archivos en ${dirPath} (¿corriste 'network.sh up'?)`);
  }
  return path.join(dirPath, files[0]);
}

async function newIdentity(cfg) {
  const certPath = await firstFile(cfg.certDirectoryPath);
  const credentials = await fs.readFile(certPath);
  return { mspId: cfg.mspId, credentials };
}

async function newSigner(cfg) {
  const keyPath = await firstFile(cfg.keyDirectoryPath);
  const privateKeyPem = await fs.readFile(keyPath);
  return signers.newPrivateKeySigner(crypto.createPrivateKey(privateKeyPem));
}

async function newGrpcConnection(cfg) {
  const tlsRootCert = await fs.readFile(cfg.tlsCertPath);
  return new grpc.Client(cfg.peerEndpoint, grpc.credentials.createSsl(tlsRootCert), {
    'grpc.ssl_target_name_override': cfg.peerHostAlias,
  });
}

// newGatewayForOrg(orgKey) devuelve { gateway, client, mspId }. El llamador
// es responsable de gateway.close() y client.close() al terminar.
async function newGatewayForOrg(orgKey) {
  const cfg = paths(orgKey);

  const client = await newGrpcConnection(cfg);
  const gateway = connect({
    client,
    identity: await newIdentity(cfg),
    signer: await newSigner(cfg),
    hash: hash.sha256,
    evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
    endorseOptions: () => ({ deadline: Date.now() + 15000 }),
    submitOptions: () => ({ deadline: Date.now() + 5000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
  });

  return { gateway, client, mspId: cfg.mspId };
}

module.exports = { newGatewayForOrg };
