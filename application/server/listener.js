// Suscripción a los eventos de chaincode del canal público, y el puente entre
// esos eventos y las dos cosas que el dashboard necesita: el feed en vivo y la
// entrega automática de clave ante cada PERMIT.
//
// Una sola suscripción alcanza: canal-universal es público a todas las
// clínicas, así que cualquiera de ellas ve todos los eventos.
'use strict';

const { listenForEvents } = require('../src/events');
const { getConn, dropConn, defaultOrgKey } = require('./connections');
const { deliverKeyFor } = require('./keys');
const { CHANNEL_NAME } = require('../src/config');

function manejarEvento(broadcast) {
  return (event, payload) => {
    // Alta y baja de instituciones: la UI las usa para refrescar la topología
    // sin hacer polling.
    if (event.eventName === 'ClinicRegistered' || event.eventName === 'ClinicDeactivated') {
      broadcast({
        type: 'clinic-event',
        eventName: event.eventName,
        mspId: payload.MspID,
        nombre: payload.Nombre,
        estado: payload.Estado,
        txId: event.transactionId,
        blockNumber: String(event.blockNumber),
      });
      return;
    }

    if (event.eventName !== 'AccessPermitted') return;

    broadcast({
      type: 'chaincode-event',
      eventName: event.eventName,
      txId: payload.TxID,
      blockNumber: String(event.blockNumber),
      requesterOrg: payload.RequesterOrg,
      fhirResourceID: payload.FhirResourceID,
      resourceType: payload.ResourceType,
      patientIDHash: payload.PatientIDHash,
      timestamp: payload.Timestamp,
    });

    // Si tenemos la clave de ese recurso y quien pide no es la org dueña, se
    // envuelve para su certificado y se registra la entrega.
    const delivery = deliverKeyFor(payload);
    if (delivery) broadcast({ type: 'key-delivery', delivery });
  };
}

// startEventListener reintenta: al boot del server la red puede no estar
// levantada todavía.
async function startEventListener(broadcast) {
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let orgKey;
    try {
      orgKey = defaultOrgKey();
      const { network } = await getConn(orgKey);
      await listenForEvents(network, manejarEvento(broadcast));
      console.log(`[fabric] Listener de eventos activo en '${CHANNEL_NAME}' (como ${orgKey})`);
      return;
    } catch (err) {
      console.warn(`[fabric] Listener no pudo arrancar (intento ${attempt}/${maxAttempts}): ${err.message}`);
      if (orgKey) await dropConn(orgKey);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.error('[fabric] El listener de eventos no pudo arrancar; ¿está la red levantada? Reiniciar el server tras levantar la red.');
}

module.exports = { startEventListener };
