package main

import (
	"bytes"
	"errors"
	"io"
	"syscall"

	"go.l3.ai/cli"
)

// Output serializes each page as one block for the shared bounded stdout writer.
type Output struct {
	writer *cli.Stdout
	block  bytes.Buffer
	err    error
}

func newOutput(out io.Writer) *Output {
	return &Output{writer: cli.NewStdout(out, outputBufferBytes, true)}
}

func (output *Output) write(page Page) {
	if output.err != nil {
		return
	}
	output.block.Reset()
	page.writeTo(&output.block)
	output.err = output.writer.WriteBlock(output.block.Bytes())
}

func (output *Output) flush() {
	if err := output.writer.Flush(); output.err == nil {
		output.err = err
	}
}

func (output *Output) failed() bool { return output.err != nil }

func (output *Output) isPipe() bool {
	return output.writer.ClosedByReader() || errors.Is(output.err, syscall.ECONNRESET)
}
