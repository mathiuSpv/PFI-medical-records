package consent

import (
	"sort"
	"strings"
)

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
