package main

import (
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxBodyBytes = 5 << 20
const drainLimitBytes = 64 << 10

var errBodyOverLimit = errors.New("body over 5 MiB")

type Http struct{ roundTripper *http.Transport }

func newHttp(tls *Tls, concurrency int) *Http {
	return &Http{roundTripper: &http.Transport{
		MaxIdleConns: concurrency * 2, MaxIdleConnsPerHost: concurrency, MaxConnsPerHost: concurrency,
		IdleConnTimeout: 90 * time.Second, DisableCompression: true, DialTLSContext: dialTLS(tls),
	}}
}

func dialTLS(tlsConfig *Tls) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := new(net.Dialer).DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		host, _, _ := net.SplitHostPort(addr)
		config := tlsConfig.load().Clone()
		config.ServerName = host
		client := tls.Client(conn, config)
		if err = client.HandshakeContext(ctx); err != nil {
			conn.Close()
			return nil, TlsError{err}
		}
		return client, nil
	}
}

func (client *Http) get(request *Request) (Response, error) {
	resp, err := client.roundTripper.RoundTrip(request.req)
	return Response{resp: resp, request: request}, err
}

type Response struct {
	resp    *http.Response
	request *Request
}

func (response *Response) status() int         { return response.resp.StatusCode }
func (response *Response) contentType() string { return response.resp.Header.Get("Content-Type") }
func (response *Response) location() string    { return latin1(response.resp.Header.Get("Location")) }

func (response *Response) retryAfterSeconds() int64 {
	val := response.resp.Header.Get("Retry-After")
	if val == "" {
		return -1
	}
	parsed, err := strconv.ParseUint(val, 10, 64)
	if err == nil {
		return int64(min(parsed, uint64(math.MaxInt64)))
	}
	if errors.Is(err, strconv.ErrRange) {
		return math.MaxInt64
	}
	return -1
}

// body feeds a decoded response to scan a fixed buffer at a time.
func (response *Response) body(scan func([]byte)) error {
	if response.resp.ContentLength > maxBodyBytes {
		return errBodyOverLimit
	}
	reader, err := decoded(response.resp)
	if err != nil {
		return err
	}
	defer reader.Close()
	buffer, read := response.request.buffer, 0
	for {
		n, err := reader.Read(buffer)
		read += n
		if read > maxBodyBytes {
			return errBodyOverLimit
		}
		if n > 0 {
			scan(buffer[:n])
		}
		if err == io.EOF {
			return nil
		} else if err != nil {
			return err
		}
	}
}

func (response *Response) skipBody() {
	if response.resp.ContentLength <= drainLimitBytes {
		io.CopyBuffer(io.Discard, io.LimitReader(response.resp.Body, drainLimitBytes+1), response.request.buffer)
	}
}

func (response *Response) close() {
	response.resp.Body.Close()
}

func decoded(resp *http.Response) (io.ReadCloser, error) {
	enc := resp.Header.Get("Content-Encoding")
	if strings.EqualFold(enc, "gzip") {
		return gzip.NewReader(resp.Body)
	}
	if strings.EqualFold(enc, "deflate") {
		return zlib.NewReader(resp.Body)
	}
	return resp.Body, nil
}

func latin1(header string) string {
	for i := range len(header) {
		if header[i] >= 0x80 {
			runes := make([]rune, len(header))
			for index := range len(header) {
				runes[index] = rune(header[index])
			}
			return string(runes)
		}
	}
	return header
}

type TlsError struct{ error }

func (e TlsError) Unwrap() error { return e.error }
