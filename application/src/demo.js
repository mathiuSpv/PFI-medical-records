// Flujo completo de punta a punta (paso 5), en un solo proceso por
// simplicidad de demo — en un despliegue real cada organización corre su
// propia instancia de esta capa de aplicación, sin acceso al material
// criptográfico de la otra. Acá simulamos ambos lados a la vez porque, en
// este entorno de desarrollo local, tenemos acceso de archivo a las dos.
//
//   1. Genérica 1 cifra un recurso FHIR de ejemplo (AES-256-GCM) y lo
//      sube a IPFS.
//   2. Genérica 1 invoca EmitAsset con el CID (el chaincode nunca ve el
//      payload ni la clave).
//   3. Genérica 1 empieza a escuchar eventos de chaincode (así reacciona
//      a un PERMIT sobre sus propios recursos).
//   4. "Solicitud de acceso": Genérica 2 le pide a Genérica 1 acceso al
//      tipo de recurso del paciente — en esta etapa es un paso fuera del
//      ledger (una llamada, un mail), no hay función de chaincode para
//      "pedir"; queda representado como un log.
//   5. Genérica 1 otorga el consentimiento (GrantConsent).
//   6. Genérica 2 pide acceso on-chain (CheckAccess) -> PERMIT.
//   7. El evento AccessPermitted le llega a Genérica 1 con el
//      certificado X.509 de Genérica 2 adentro.
//   8. Genérica 1 envuelve la clave AES del recurso para ese
//      certificado y "entrega" la clave — acá el log simulado, en vez de
//      un envío real por HTTP/mTLS entre orgs (eso queda para una etapa
//      futura, ver PLAN.md).
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const { newGatewayForOrg } = require('./connect');
const { listenForEvents } = require('./events');
const { encryptResource, decryptResource, wrapKeyForRecipient } = require('./crypto');
const { uploadToIPFS, downloadFromIPFS } = require('./ipfs');
const { patientRef } = require('./patient');
const { CHANNEL_NAME, CHAINCODE_NAME } = require('./config');

const SAMPLE_PATH = path.join(__dirname, '..', 'sample-data', 'observation-001.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function oneYearFromNow() {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function main() {
  console.log('=== PFI — demo de punta a punta: emisión, consentimiento, ABAC y entrega de clave ===\n');

  const generica1 = await newGatewayForOrg('generica1');
  const generica2 = await newGatewayForOrg('generica2');

  // "keystore" del prototipo: mapa en memoria de claves AES por recurso.
  // Fuera de alcance en esta etapa: HSM / gestión de claves persistente.
  const keyStore = new Map();

  try {
    const scNetwork = generica1.gateway.getNetwork(CHANNEL_NAME);
    const scContract = scNetwork.getContract(CHAINCODE_NAME);
    const mtNetwork = generica2.gateway.getNetwork(CHANNEL_NAME);
    const mtContract = mtNetwork.getContract(CHAINCODE_NAME);

    // --- 1) Cifrar el recurso de ejemplo y subirlo a IPFS -----------------
    const resource = JSON.parse(await fs.readFile(SAMPLE_PATH, 'utf8'));
    const { blob, aesKey } = encryptResource(resource);
    const cid = await uploadToIPFS(blob, 'observation-001.enc');
    console.log(`[${generica1.mspId}] Recurso cifrado subido a IPFS. CID=${cid}`);

    // Verificación de punta a punta del pipeline cifrar->IPFS->descifrar.
    const downloaded = await downloadFromIPFS(cid);
    const roundtrip = decryptResource(downloaded, aesKey);
    assert.deepEqual(roundtrip, resource);
    console.log(`[${generica1.mspId}] Verificado: IPFS.cat(${cid}) descifra igual al original`);

    const fhirResourceID = `obs-${Date.now()}`;
    const resourceType = 'Observation';
    // Referencia opaca del paciente: HMAC con la clave de red, no un hash
    // pelado — ver patient.js para por qué el SHA-256 directo no alcanzaba.
    const patientIDHash = patientRef('paciente-demo-001');
    // Indexado por recurso: dos activos del mismo tipo y paciente ya no se pisan.
    keyStore.set(fhirResourceID, aesKey);

    // --- 2) EmitAsset: metadatos públicos en canal-universal ---------------
    await scContract.submitTransaction('EmitAsset', fhirResourceID, resourceType, cid, patientIDHash);
    console.log(`[${generica1.mspId}] EmitAsset OK (fhirResourceID=${fhirResourceID})`);

    // --- 3) Genérica 1 escucha eventos sobre sus propios recursos -------
    const { events, done: listenerDone } = await listenForEvents(scNetwork, (event, payload) => {
      if (event.eventName !== 'AccessPermitted') return;
      if (payload.FhirResourceID !== fhirResourceID) return;

      console.log(`\n<-- [${generica1.mspId}] Evento AccessPermitted recibido (tx ${event.transactionId})`);
      console.log(`    Solicitante: ${payload.RequesterOrg}`);

      const key = keyStore.get(payload.FhirResourceID);
      if (!key) {
        console.log('    (sin clave local para este recurso, se ignora)');
        return;
      }

      const envelope = wrapKeyForRecipient(key, payload.RequesterCertPEM);
      console.log(`    Clave AES envuelta para ${envelope.recipientSubject} (ECDH P-256 + HKDF-SHA256 + AES-256-GCM)`);
      console.log('    *** Entrega de clave (simulada — log, no hay envío real todavía) ***');
      console.log(`    Envelope: ${JSON.stringify(envelope, null, 2)}`);
    });

    // --- 4) Solicitud de acceso (fuera del ledger en esta etapa) -----------
    console.log(`\n[${generica2.mspId}] Solicitud de acceso al recurso ${fhirResourceID} (${resourceType}) del paciente ${patientIDHash.slice(0, 12)}… (fuera del ledger: mail/llamada a Genérica 1)`);

    // --- 5) GrantConsent -----------------------------------------------------
    await scContract.submitTransaction(
      'GrantConsent',
      patientIDHash,
      generica2.mspId,
      JSON.stringify([resourceType]),
      oneYearFromNow(),
    );
    console.log(`[${generica1.mspId}] GrantConsent OK (${generica2.mspId}, ${resourceType}, 1 año)`);

    // --- 6) CheckAccess (on-chain, ABAC) -------------------------------------
    // Va por recurso puntual: el tipo y el paciente los deriva el chaincode del
    // activo, así que el solicitante no puede declararlos a conveniencia.
    const decisionBytes = await mtContract.submitTransaction('CheckAccess', fhirResourceID);
    const decision = Buffer.from(decisionBytes).toString('utf8');
    console.log(`[${generica2.mspId}] CheckAccess -> ${decision}`);
    assert.equal(decision, 'PERMIT');

    // Darle un respiro al listener asincrónico para procesar el evento.
    await sleep(2000);

    events.close();
    await listenerDone;

    console.log('\n=== Demo completa ===');
  } finally {
    generica1.gateway.close();
    generica1.client.close();
    generica2.gateway.close();
    generica2.client.close();
  }
}

main().catch((error) => {
  console.error('******** FAILED:', error);
  process.exitCode = 1;
});
