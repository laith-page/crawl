package main

import (
	"crypto/tls"
	"sync"

	"go.l3.ai/certs"
)

type Tls struct {
	certFile string
	once     sync.Once
	config   *tls.Config
}

func newTls(certFile string) *Tls { return &Tls{certFile: certFile} }

func (tlsConfig *Tls) load() *tls.Config {
	tlsConfig.once.Do(func() {
		tlsConfig.config = certs.ClientConfig(tlsConfig.certFile)
		tlsConfig.config.NextProtos = []string{"http/1.1"}
		tlsConfig.config.CurvePreferences = []tls.CurveID{tls.X25519, tls.CurveP256}
	})
	return tlsConfig.config
}
