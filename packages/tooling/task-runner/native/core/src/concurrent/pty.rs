use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::mpsc;

use super::events::EventSink;
use super::process::{CompletionMessage, ProcessInfo};
use super::types::{ConcurrentCommandConfig, PtySize};

pub(crate) struct PtyControl;

impl PtyControl {
    pub(crate) fn resize(&self, _size: PtySize) {}
}

pub(crate) fn spawn_pty(
    _index: u32,
    _config: &ConcurrentCommandConfig,
    _sink: &EventSink,
    _completion_tx: mpsc::UnboundedSender<CompletionMessage>,
    _shell_path: Option<&str>,
    _giving_up: &Arc<AtomicBool>,
) -> Result<ProcessInfo, std::io::Error> {
    Err(std::io::Error::other("pty is not supported yet"))
}
