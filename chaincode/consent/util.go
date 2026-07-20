package consent

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// getAllByPrefix recorre el world state por rango de prefijo y deserializa
// cada valor como T. Devuelve slice inicializado (nunca nil): nil serializa
// a JSON "null" y el schema de contractapi exige "array" (mismo bug ya
// corregido en RevokeConsent).
func getAllByPrefix[T any](ctx contractapi.TransactionContextInterface, prefix string) ([]*T, error) {
	iterator, err := ctx.GetStub().GetStateByRange(prefix, prefix+"￿")
	if err != nil {
		return nil, fmt.Errorf("error leyendo world state: %v", err)
	}
	defer iterator.Close()

	out := []*T{}
	for iterator.HasNext() {
		kv, err := iterator.Next()
		if err != nil {
			return nil, err
		}
		var item T
		if err := json.Unmarshal(kv.Value, &item); err != nil {
			return nil, err
		}
		out = append(out, &item)
	}
	return out, nil
}

// dedupSorted normaliza una lista de resource types: recorta espacios,
// descarta vacíos, quita duplicados y ordena. El orden fijo es lo que hace
// determinista el JSON resultante (la iteración de un map en Go no lo es).
func dedupSorted(items []string) []string {
	set := make(map[string]struct{}, len(items))
	for _, it := range items {
		it = strings.TrimSpace(it)
		if it == "" {
			continue
		}
		set[it] = struct{}{}
	}
	out := make([]string, 0, len(set))
	for it := range set {
		out = append(out, it)
	}
	sort.Strings(out)
	return out
}

// subtractSorted devuelve base sin los elementos de remove, ordenado.
func subtractSorted(base []string, remove []string) []string {
	removeSet := make(map[string]struct{}, len(remove))
	for _, r := range remove {
		removeSet[r] = struct{}{}
	}
	out := make([]string, 0, len(base))
	for _, b := range base {
		if _, found := removeSet[b]; !found {
			out = append(out, b)
		}
	}
	sort.Strings(out)
	return out
}

func containsString(list []string, target string) bool {
	for _, v := range list {
		if v == target {
			return true
		}
	}
	return false
}
