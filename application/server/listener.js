// Suscripción a los eventos de chaincode y el puente entre esos eventos y las
// dos cosas que el dashboard necesita: el feed en vivo y la entrega automática
// de clave ante cada PERMIT.
//
// Con la topología jerárquica una suscripción al nacional NO alcanza: un acceso
// entre dos clínicas de la misma provincia se resuelve en su canal provincial y
// su evento AccessPermitted sólo se ve ahí. Por eso se escucha el nacional y
// cada canal provincial. Como cada transacción vive en un solo canal, no hay
// doble entrega. Los eventos de clínica (RegisterClinic corre en TODOS los
// canales al desplegar) se manejan sólo en el nacional para no duplicarlos.
'use strict';

const { listenForEvents } = require('../src/events');
const { getConn } = require('./connections');
const { channelReaders } = require('./readmodel');
const { NATIONAL_CHANNEL } = require('../src/config');
const { deliverKeyFor } = require('./keys');

function manejarEvento(broadcast, channel) {
  return (event, payload) => {
    // Alta y baja de instituciones: sólo en el nacional (el evento se emite en
    // cada canal donde corre RegisterClinic; se maneja una vez para no duplicar).
    if (event.eventName === 'ClinicRegistered' || event.eventName === 'ClinicDeactivated') {
      if (channel !== NATIONAL_CHANNEL) return;
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
      channel,
    });

    // Si tenemos la clave de ese recurso y quien pide no es la org dueña, se
    // envuelve para su certificado y se registra la entrega.
    const delivery = deliverKeyFor(payload);
    if (delivery) broadcast({ type: 'key-delivery', delivery });
  };
}

// listenOnChannel suscribe un canal con reintentos: al boot del server la red
// puede no estar levantada todavía. La caché de conexiones desaloja sola un
// intento fallido, así que basta reintentar getConn.
async function listenOnChannel(broadcast, { channel, orgKey }) {
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { network } = await getConn(orgKey, channel);
      await listenForEvents(network, manejarEvento(broadcast, channel));
      console.log(`[fabric] Listener de eventos activo en '${channel}' (como ${orgKey})`);
      return;
    } catch (err) {
      console.warn(`[fabric] Listener '${channel}' no arrancó (intento ${attempt}/${maxAttempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.error(`[fabric] El listener de '${channel}' no pudo arrancar; ¿está la red levantada?`);
}

// startEventListener suscribe el nacional y cada canal provincial, cada uno con
// su propio org miembro (channelReaders), en paralelo.
async function startEventListener(broadcast) {
  const readers = channelReaders();
  await Promise.all(readers.map((r) => listenOnChannel(broadcast, r)));
}

module.exports = { startEventListener };
