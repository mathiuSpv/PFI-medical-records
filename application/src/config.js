// Configuración de las dos orgs de ejemplo y del canal/chaincode del paso 3.
// Los paths de material criptográfico apuntan a network/organizations, que
// genera `network/network.sh up` — hace falta la red arriba antes de correr
// esta app.
'use strict';

const path = require('node:path');

const NETWORK_HOME = path.resolve(__dirname, '..', '..', 'network');

const CHANNEL_NAME = 'canal-universal';
const CHAINCODE_NAME = 'consent';

const ORGS = {
  sancristobal: {
    mspId: 'ClinicaSanCristobalMSP',
    domain: 'sancristobal.example.com',
    peerEndpoint: '127.0.0.1:7051',
    peerHostAlias: 'peer0.sancristobal.example.com',
  },
  montenegro: {
    mspId: 'ClinicaMontenegroMSP',
    domain: 'montenegro.example.com',
    peerEndpoint: '127.0.0.1:9051',
    peerHostAlias: 'peer0.montenegro.example.com',
  },
};

// paths(orgKey) resuelve los archivos de identidad de User1 de esa org
// (el usuario "de aplicación", no el Admin de canal) dentro de
// network/organizations/peerOrganizations/<domain>.
function paths(orgKey) {
  const org = ORGS[orgKey];
  if (!org) {
    throw new Error(`Organización desconocida: ${orgKey} (usar 'sancristobal' o 'montenegro')`);
  }

  const orgHome = path.join(NETWORK_HOME, 'organizations', 'peerOrganizations', org.domain);
  const userHome = path.join(orgHome, 'users', `User1@${org.domain}`, 'msp');

  return {
    ...org,
    tlsCertPath: path.join(orgHome, 'peers', `peer0.${org.domain}`, 'tls', 'ca.crt'),
    certDirectoryPath: path.join(userHome, 'signcerts'),
    keyDirectoryPath: path.join(userHome, 'keystore'),
  };
}

const IPFS_API_URL = process.env.IPFS_API_URL || 'http://127.0.0.1:5001';

module.exports = { ORGS, paths, CHANNEL_NAME, CHAINCODE_NAME, IPFS_API_URL };
