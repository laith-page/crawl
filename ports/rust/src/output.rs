//! Pages to stdout through the CLI library's bounded block writer.

use crate::page::Page;
use std::io::{ErrorKind, Write};

pub struct Output<W: Write> {
    writer: cli::Stdout<W>,
    block: Vec<u8>,
    pipe: bool,
}

impl<W: Write> Output<W> {
    pub fn new(out: W) -> Self {
        Self {
            writer: cli::Stdout::new(out, crate::crawler::OUTPUT_BUFFER_BYTES),
            block: Vec::with_capacity(4096),
            pipe: false,
        }
    }

    pub fn write(&mut self, page: &Page) {
        if self.writer.failed() {
            return;
        }
        self.block.clear();
        page.write_to(&mut self.block);
        if let Err(error) = self.writer.write_block(&self.block) {
            self.pipe = matches!(
                error.kind(),
                ErrorKind::BrokenPipe | ErrorKind::ConnectionReset
            );
        }
    }

    pub fn flush(&mut self) {
        if let Err(error) = self.writer.close() {
            self.pipe = matches!(
                error.kind(),
                ErrorKind::BrokenPipe | ErrorKind::ConnectionReset
            );
        }
    }

    pub fn failed(&self) -> bool {
        self.writer.failed()
    }

    /// Whether stdout was closed by its reader (e.g. head).
    pub fn is_pipe(&self) -> bool {
        self.pipe || self.writer.closed_by_reader()
    }
}
