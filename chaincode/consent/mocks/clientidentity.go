package mocks

import (
	"crypto/x509"
	"errors"
)

// ClientIdentity es un doble escrito a mano de cid.ClientIdentity, a diferencia
// del resto de los mocks de este paquete que están generados con counterfeiter.
// La interfaz tiene cinco métodos y el chaincode usa dos, así que un fake
// generado de 300 líneas sería peor de leer que esto.
//
// Es el mock más importante de la suite: la identidad de quien firma la
// transacción es de donde salen TODAS las decisiones de autorización del
// chaincode (nunca de un argumento), así que casi cada test se distingue del
// anterior por qué org está firmando.
type ClientIdentity struct {
	MspID string
	Cert  *x509.Certificate
	Err   error
}

func (c *ClientIdentity) GetID() (string, error) {
	if c.Err != nil {
		return "", c.Err
	}
	return "x509::CN=test::CN=ca", nil
}

func (c *ClientIdentity) GetMSPID() (string, error) {
	if c.Err != nil {
		return "", c.Err
	}
	return c.MspID, nil
}

func (c *ClientIdentity) GetAttributeValue(string) (string, bool, error) {
	return "", false, nil
}

func (c *ClientIdentity) AssertAttributeValue(string, string) error {
	return errors.New("no implementado en el mock")
}

func (c *ClientIdentity) GetX509Certificate() (*x509.Certificate, error) {
	if c.Err != nil {
		return nil, c.Err
	}
	if c.Cert == nil {
		// CheckAccess mete el certificado del solicitante en el AccessLog y en
		// el evento, así que necesita uno válido aunque el test no lo mire.
		return &x509.Certificate{Raw: []byte("certificado-de-prueba")}, nil
	}
	return c.Cert, nil
}
