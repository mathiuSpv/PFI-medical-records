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

## 4b. Incorporar o sacar instituciones

Desde el dashboard, panel **Instituciones del bus**, o por consola:

```bash
cd network
./network.sh clinics                                  # listado y estado
./network.sh addClinic rosario "Hospital Rosario"     # alta   (~40 s)
./network.sh removeClinic rosario "fin de convenio"   # baja   (~20 s)
```

El alta crea una organización Fabric real (MSP y peer propios) y la incorpora a
`canal-universal` con una actualización de config firmada por las clínicas existentes;
la baja hace el camino inverso. El detalle de cada paso está en el
[README § Alta y baja de instituciones](README.md#alta-y-baja-de-instituciones).

## 4c. Correr los tests del chaincode

No necesitan la red levantada: corren contra un world state en memoria.

```bash
cd chaincode && go test ./consent/ -v
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
- **`go list` falla con "error obtaining VCS status" al hacer `deployCC`** → git no
  confía en el repo porque el bind mount lo deja con otro dueño (pasa clonando en
  Windows). Dentro del contenedor:
  `git config --global --add safe.directory /workspaces/pfi-medical-records`.
- **Editás el front y el navegador no cambia** → son dos causas distintas y conviene
  descartar las dos:
  1. Sobre el bind mount de un devcontainer en Windows los eventos de inotify no
     llegan, así que HMR nunca dispara. Arrancar con `VITE_POLLING=1 npm run dev`.
  2. Quedó un Vite viejo corriendo. `pkill -f vite` **no** sirve: el cmdline del propio
     shell contiene "vite", así que pkill se mata a sí mismo antes de llegar al resto y
     el server viejo sobrevive. Con `strictPort` ahora el nuevo falla en vez de mudarse
     de puerto en silencio, pero para matarlo:
     `ps -eo pid,args | awk '/node_modules\/\.bin\/vite/ {print $1}' | xargs -r kill`
