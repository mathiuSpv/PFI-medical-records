# Targets del chaincode: tests, cobertura y mutación real.
#
# La "mutación" del Proyecto NO es la inyección de fallos de los *_test.go (que
# prueba que una operación aborte ante un world state roto): es mutation testing
# de verdad — gremlins introduce mutantes en el código fuente y mide cuántos
# mata la batería. Un mutante vivo = una línea que ningún test distingue.
#
# gremlins corre el subconjunto de tests que cubre cada línea mutada; el
# coeficiente de timeout alto compensa que cada mutante recompila (el test base
# dura ms y sin margen todo daría TIMED OUT). Se excluyen los mocks generados.

GREMLINS_FLAGS = --timeout-coefficient 100 -E "mocks/"
# Gates de calidad: gremlins sale con error si no se alcanzan (CI-friendly).
GREMLINS_THRESHOLDS = --threshold-efficacy 90 --threshold-mcover 90

.PHONY: test cover mutation install-tools

test:
	go test ./consent/

cover:
	go test ./consent/ -coverprofile=cover.out
	go tool cover -func=cover.out | tail -1

mutation:
	gremlins unleash ./consent/ $(GREMLINS_FLAGS) $(GREMLINS_THRESHOLDS)

# Instala gremlins en $GOBIN (por defecto $GOPATH/bin, en PATH dentro del
# devcontainer). Correr una vez antes de `make mutation`.
install-tools:
	go install github.com/go-gremlins/gremlins/cmd/gremlins@latest
