# Plan de trabajo — Etapa 1

Prototipo punta a punta en entorno local: red Fabric 2 orgs + chaincode de consentimiento
ABAC + IPFS local + cliente de aplicación. Este archivo trackea el avance entre sesiones;
las decisiones de arquitectura (cerradas) están resumidas en el [README](README.md).

## Estado

| Paso | Descripción | Estado |
|------|-------------|--------|
| 0 | Devcontainer con dependencias Fabric | ✅ Completo |
| 1 | test-network de referencia funcionando | ✅ Completo |
| 2 | Red propia 2 orgs (Clínica San Cristóbal + Clínica Montenegro) | ✅ Completo |
| 3 | Chaincode Go (consentimiento + ABAC) | ✅ Completo |
| 4 | Nodo IPFS local (Kubo) | ✅ Completo |
| 5 | Cliente de aplicación (Node.js) | ✅ Completo |
| 6 | README de estudio completo | 🔄 Continuo (se actualiza en cada paso) |

## Paso 0 — Devcontainer

- [x] `devcontainer.json`: Ubuntu 22.04 + Docker-in-Docker + Go 1.23 + Node LTS
- [x] `post-create.sh`: jq, binarios Fabric 2.5.12 LTS, fabric-samples, imágenes Docker
- [x] `.gitattributes`: LF forzado en `.sh`/`.yaml` (evita `$'\r': command not found` al clonar desde Windows)
- [x] README: requisitos host macOS/Windows, cómo levantar el entorno
- [x] Verificar build completo del devcontainer (`devcontainer up`)
- [x] Verificar dentro del contenedor: `peer version`, `configtxgen --version`, `docker info`

Decisión: Docker-in-Docker (no socket del host) porque la test-network hace bind mounts
de rutas que solo existen dentro del devcontainer.

## Paso 1 — test-network de referencia

- [x] `./network.sh up createChannel` sin errores (2 orgs + orderer Raft + canal `mychannel`)
- [x] `./network.sh deployCC` con chaincode de ejemplo Go (asset-transfer-basic)
- [x] Invoke + query manuales con el CLI `peer` (entender los `export` de identidad MSP/TLS)
- [x] `./network.sh down` limpio

Objetivo: entorno de referencia validado + material de estudio de la anatomía de una red
Fabric antes de armar la propia.

Incidente resuelto (ver README § Troubleshooting): `peer lifecycle chaincode install`
fallaba con `docker image build failed: write unix @->/var/run/docker.sock: write:
broken pipe`. Causa: el chaincode builder legacy de Fabric 2.5 es incompatible con
Docker/Moby ≥ 25 (la feature del devcontainer traía `29.6.1` con `version: "latest"`).
Fix: pinear `ghcr.io/devcontainers/features/docker-in-docker` a `"version": "24"` en
`devcontainer.json` (ya aplicado). Requiere rebuild del devcontainer para quedar limpio;
esta sesión se resolvió en caliente con `apt-get install --allow-downgrades
moby-engine=24.0.9-ubuntu22.04u2` + reinicio de `dockerd`.

## Paso 2 — Red propia (`network/`)

Orgs de ejemplo: **Clínica San Cristóbal** (`ClinicaSanCristobalMSP`) y **Clínica
Montenegro** (`ClinicaMontenegroMSP`) — dos instituciones de salud intercambiando
recursos entre sí (en vez del par clínica/laboratorio previsto originalmente; el
diseño de canales es el mismo, generalizado a "canal privado por org").

- [x] Material criptográfico con cryptogen: `network/crypto-config/{orderer,sancristobal,montenegro}.yaml`
- [x] `network/configtx/configtx.yaml`: 2 orgs + orderer Raft compartido (1 nodo), sin
      canal de sistema (channel participation API), 3 perfiles — uno por canal
- [x] `network/compose/compose-network.yaml`: orderer + peer0.sancristobal + peer0.montenegro
      (Docker-in-Docker montado en los peers para el chaincode builder legacy, mismo
      patrón que test-network)
- [x] Canal público `canal-universal` (ambas orgs como miembros de aplicación)
- [x] Canal privado `canal-sancristobal` (solo ClinicaSanCristobalMSP) y
      `canal-montenegro` (solo ClinicaMontenegroMSP) — bitácora interna por org,
      orderer compartido con el resto de los canales
- [x] `network/network.sh {up|createChannels|down}` — probado punta a punta: los 3
      canales quedan creados y unidos, `peer channel list` confirma que cada peer
      solo ve `canal-universal` + su propio canal privado (aislamiento correcto)

## Paso 3 — Chaincode Go (`chaincode/`)

- [x] `EmitAsset(fhirResourceID, resourceType, ipfsCid, patientIDHash)` — registra metadatos; NO toca IPFS
- [x] `GrantConsent(patientIDHash, grantedToOrg, resourceTypesJSON, expiry)` — deny por defecto, mínimo privilegio (resourceTypes no puede quedar vacío, expiry no puede ser pasado, una org no puede otorgarse consentimiento a sí misma)
- [x] `RevokeConsent(patientIDHash, grantedToOrg, resourceTypesJSON)` — total (`[]`) o parcial; solo la org que otorgó puede revocar; historial inmutable vía `GetHistoryForKey` (expuesto en `GetConsentHistory`, probado: grant + revoke quedan como versiones separadas)
- [x] `CheckAccess(resourceType, patientIDHash)` — ABAC: consentimiento vigente + scope + expiry; registra PERMIT/DENY en ledger (auditoría con TxID, timestamp, requesterOrg, resourceType, reason) vía `GetAccessLog`
- [x] Evento de chaincode `AccessPermitted` ante PERMIT (para que la app emisora dispare entrega de clave — paso 5)
- [x] Restricción: determinista (timestamp vía `ctx.GetStub().GetTxTimestamp()`, nunca `time.Now()`; listas siempre dedupeadas+ordenadas antes de persistir), sin llamadas de red, solo `ChaincodeStub`/`ClientIdentity`
- [x] Desplegado en `canal-universal` vía `network/network.sh deployCC` (nuevo comando), probado con CLI `peer`: flujo completo emit → deny sin consentimiento → grant → permit → deny por resource type no autorizado → revocación parcial → intento de revocar por la org no otorgante (rechazado) → revocación total → deny final → historial con las 2 versiones

Desvío deliberado del checklist original: `CheckAccess` no recibe `requester_org` como
argumento — se toma de `ctx.GetClientIdentity().GetMSPID()` (la identidad que firma la
tx). Si fuera un parámetro, cualquier org podría pasar el MSPID de otra y usar el
resultado/evento como oráculo de si esa otra org tiene consentimiento o no. El resto de
la firma sigue el plan original.

Bug encontrado y corregido durante las pruebas: `RevokeConsent` total dejaba
`ResourceTypes = nil`, que serializa a JSON `null`; el schema autogenerado por
`contractapi` para el valor de retorno de `GetConsent` exige `array` y rechazaba `null`
con `endorsement failure ... Invalid type. Expected: array, given: null`. Fix: usar
`[]string{}` en vez de `nil`.

Ampliado en el paso 5: `AccessLog` (y por lo tanto el evento `AccessPermitted`) suma
`RequesterCertPEM` — el certificado X.509 del solicitante vía
`ctx.GetClientIdentity().GetX509Certificate()` (determinista, sin red). Sin esto la app
de la org dueña del recurso no tenía forma de conseguir la clave pública del solicitante
para envolver la clave AES.

## Paso 4 — IPFS local (`docker-compose` en `network/` o propio)

- [x] Kubo en Docker, un solo nodo (`network/compose/compose-ipfs.yaml`), API en :5001,
      gateway HTTP en :8080. Comandos `network/network.sh {ipfsUp|ipfsDown}` — `ipfsUp`
      espera activamente a que la API responda antes de devolver el control
- [x] Verificar add/cat por API: `POST /api/v0/add` (multipart) y `POST /api/v0/cat?arg=<CID>`
      probados con un archivo de prueba — contenido recuperado idéntico al original,
      también confirmado por el gateway (`GET :8080/ipfs/<CID>`)

Sin red compartida con `network/compose/compose-network.yaml` a propósito: la capa de
aplicación (paso 5) le habla a Fabric y a IPFS por `localhost` con los puertos
publicados, no hace falta que los contenedores se vean entre sí por la red docker.

## Paso 5 — Cliente de aplicación (`application/`)

Node.js + `@hyperledger/fabric-gateway` (decidido: chaincode ya es Go; Node separa
"dentro/fuera del ledger", Gateway SDK Node es el más documentado para apps, listener de
eventos + HTTP entre orgs con menos ceremonia).

- [x] Cifrar JSON de ejemplo con AES-256-GCM (`src/crypto.js`: `encryptResource`, iv+authTag+ciphertext empaquetados en un solo blob)
- [x] Subir a IPFS local, obtener CID (`src/ipfs.js`, API HTTP de Kubo — `fetch`/`FormData`/`Blob` nativos de Node, sin cliente IPFS aparte)
- [x] Invocar `EmitAsset` con el CID
- [x] Flujo completo simulado: solicitud de acceso (fuera del ledger, representada como log) → `GrantConsent` → `CheckAccess` → evento `AccessPermitted` → entrega de clave (log simulado en esta etapa) — `src/demo.js`, probado de punta a punta con la red y el chaincode reales
- [x] Listener de eventos de chaincode por org: `src/listen.js <org>` standalone (una terminal por org, hasta Ctrl+C), lógica de escucha compartida con `demo.js` vía `src/events.js`

Decisiones no explícitas en el checklist original:

- **Envoltura de la clave AES real, no solo mencionada**: los certificados de Fabric
  (cryptogen) son EC P-256, no RSA, así que "envolver con la clave pública X.509" no
  puede ser RSA-OAEP directo. `src/crypto.js#wrapKeyForRecipient` arma un esquema tipo
  ECIES: ECDH efímero contra la clave pública del certificado del solicitante → HKDF-SHA256
  → AES-256-GCM envuelve la clave real. Probado con `unwrapKey` (round-trip) contra un
  certificado de prueba, y en la demo con el certificado **real** de `User1@montenegro`
  extraído del evento (ver próximo punto).
- **`GetChaincodeEvents` de `fabric-gateway` no necesitaba el `sleep` manual del paso 3**:
  `contract.submitTransaction(...)` del SDK Node espera el commit antes de devolver el
  control (a diferencia de `peer chaincode invoke` por CLI) — no volvió a aparecer
  `MVCC_READ_CONFLICT` en ninguna corrida de la demo.
- **Un solo proceso simula las dos orgs**: `demo.js` abre dos `Gateway` (uno por org, cada
  uno con su propia identidad/MSP) en el mismo proceso, porque en este entorno de
  desarrollo local tenemos acceso de archivo al material criptográfico de ambas. En un
  despliegue real cada organización correría su propia instancia de esta capa, sin acceso
  a la identidad de la otra — el código ya está separado por org (`connect.js` no sabe de
  "las dos", solo de "una org a la vez") para que separarlos en dos procesos sea trivial
  más adelante.
- **Sin service discovery manual**: a diferencia del CLI (`--peerAddresses` de ambas orgs
  en el paso 3), el SDK Gateway resuelve el endorsement cross-org automáticamente vía el
  servicio de discovery del peer conectado (usa los anchor peers configurados en el
  paso 2) — alcanza con conectarse al peer de la propia org.

## Fuera de alcance (etapa 1)

IPFS distribuido/pinning externo, modelado FHIR completo, HSM/gestión avanzada de claves.

## Etapas futuras (solo referencia, no implementar aún)

- Modelado FHIR R4 real de recursos
- Entrega de clave por HTTP/mTLS real entre orgs (hoy: log simulado)
- Múltiples nodos IPFS / pinning
- Evaluación empírica (métricas de latencia/throughput para la tesis)
