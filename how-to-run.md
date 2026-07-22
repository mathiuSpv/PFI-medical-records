# Cómo correr el proyecto (guía rápida)

Camino mínimo desde un clon fresco hasta el dashboard funcionando. Los detalles,
decisiones de arquitectura y troubleshooting están en el [README](README.md); el avance
por pasos en [PLAN.md](PLAN.md).

## 1. Requisitos del host

Solo dos cosas (macOS o Windows; en Linux alcanza con Docker + VS Code):

1. **Docker Desktop** corriendo, con ≥ 8 GB de RAM asignados (Settings → Resources).
2. **VS Code** con la extensión **Dev Containers** (`ms-vscode-remote.remote-containers`).

No instalar Go, Node ni binarios de Fabric en el host: todo vive dentro del contenedor.

## 2. Abrir el devcontainer

Abrir la carpeta del repo en VS Code → `F1` → **Dev Containers: Reopen in Container**.

La primera vez tarda varios minutos: construye la imagen, instala Go/Node/Docker-in-Docker,
descarga los binarios de Fabric 2.5 y las imágenes Docker. Verificación rápida al entrar:

```bash
peer version && docker info > /dev/null && echo OK
```

> Si `peer` no aparece o `~/fabric-samples` no existe, la descarga falló durante la
> creación (suele ser la red que aún no estaba lista). Correr a mano:
> `bash .devcontainer/post-create.sh` — es reintentable.

## 3. Levantar la infraestructura

Todo desde `network/` (cada comando espera al anterior):

```bash
cd network
./network.sh up              # cryptogen + orderer + peer de cada clínica
./network.sh createChannels  # canal-universal + canal privado por clínica
./network.sh deployCC        # chaincode de consentimiento en canal-universal
./network.sh ipfsUp          # nodo IPFS (Kubo), API en :5001
```

## 4. Correr el dashboard web

Dos terminales:

```bash
# Terminal 1 — backend (BFF): REST + eventos en vivo sobre la red
cd application && npm install && npm run server

# Terminal 2 — frontend React
cd application/web && npm install && npm run dev
```

Abrir **http://localhost:5173**. Desde ahí se opera todo eligiendo con qué clínica
actuar: emitir un activo (se cifra y sube a IPFS), pedir acceso (da **DENY**), otorgar
el consentimiento, volver a pedir acceso (da **PERMIT**, dispara el evento y la entrega
de clave en el feed) y descifrar el recurso como la clínica destinataria.

### Alternativa sin navegador

El flujo completo también corre por consola:

```bash
cd application && npm install && npm run demo
```

## 5. Bajar todo

```bash
cd network
./network.sh ipfsDown
./network.sh down    # borra contenedores, volúmenes y material criptográfico generado
```

La red es descartable: `down` + los comandos del paso 3 la recrean desde cero en ~2
minutos. Las claves AES del dashboard viven en memoria del backend, así que tras
reiniciar el server las entregas viejas ya no se pueden descifrar (los metadatos
on-chain e IPFS persisten mientras la red siga arriba).

## Problemas frecuentes

- **`chaincode install` falla con "broken pipe"** → el devcontainer quedó con un Docker
  más nuevo que el pineado; ver README § Troubleshooting (fix: rebuild del contenedor, o
  downgrade en caliente de `moby-engine`).
- **El dashboard muestra nodos en rojo o errores** → falta algún paso del punto 3, o el
  backend se levantó antes que la red; reiniciar `npm run server` con la red arriba.
- **`MVCC_READ_CONFLICT` probando con el CLI `peer`** → esperar ~3 s entre transacciones
  dependientes (explicado en README § Troubleshooting; el SDK y el dashboard no lo
  sufren).
