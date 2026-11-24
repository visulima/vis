//! The ordered event stream between the runner and whoever consumes it.
//!
//! Every event of a run travels through one queue, so the order the runner
//! produced them in is the order the consumer sees them in. The queue is bounded
//! where it can grow without limit: output lines. Each output event costs one
//! credit, and a reader that has none left waits before it reads more from its
//! pipe, so a child that outpaces the consumer blocks on its own `write` instead
//! of filling memory. Lifecycle events (`Started`, `Close`, `Error`) are at most
//! three per command, cost nothing, and never wait, which keeps the runner's own
//! loop responsive to an abort however slow the consumer is.
//!
//! Credits come back when the consumer drops the batch an event arrived in, so a
//! consumer that holds a batch until its host has really processed it (rather
//! than until it was queued somewhere else) bounds the whole chain.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::runtime::Handle;
use tokio::sync::{mpsc, Semaphore};

use super::types::ProcessEvent;

/// Whether `event` is a line of output, the only kind that costs a credit.
fn is_output(event: &ProcessEvent) -> bool {
    matches!(event, ProcessEvent::Stdout { .. } | ProcessEvent::Stderr { .. })
}

/// The sending half of a run's event stream. Cheap to clone.
#[derive(Clone)]
pub struct EventSink {
    tx: mpsc::UnboundedSender<ProcessEvent>,
    /// `None` for an unbounded stream, which is what a bare channel converts into.
    credits: Option<Arc<Semaphore>>,
    /// Counts the senders of one command that are parked waiting for a credit.
    parked: Option<Arc<AtomicUsize>>,
}

impl From<mpsc::UnboundedSender<ProcessEvent>> for EventSink {
    fn from(tx: mpsc::UnboundedSender<ProcessEvent>) -> Self {
        Self { tx, credits: None, parked: None }
    }
}

impl EventSink {
    /// A copy that reports, in `parked`, how many of its senders wait for a credit.
    ///
    /// The runner gives a command a grace period for its pipes to reach EOF after it
    /// exits. A reader that is parked on credits has not stalled on its pipe, so that
    /// time must not count against it.
    pub(crate) fn counting_parked(&self, parked: Arc<AtomicUsize>) -> Self {
        Self { parked: Some(parked), ..self.clone() }
    }

    /// Queue a lifecycle event. Never waits. False once the stream has been closed.
    pub fn send(&self, event: ProcessEvent) -> bool {
        self.tx.send(event).is_ok()
    }

    /// Queue an output event, waiting for a credit first. False once the stream has been closed.
    pub async fn send_output(&self, event: ProcessEvent) -> bool {
        debug_assert!(is_output(&event), "only output events carry a credit");

        if let Some(credits) = &self.credits {
            let _parked = self.park();

            match credits.acquire().await {
                // The credit comes back when the batch carrying the event is dropped.
                Ok(permit) => permit.forget(),
                Err(_) => return false,
            }
        }

        self.tx.send(event).is_ok()
    }

    /// [`Self::send_output`] for a thread that is not part of the async runtime.
    pub fn send_output_blocking(&self, runtime: &Handle, event: ProcessEvent) -> bool {
        runtime.block_on(self.send_output(event))
    }

    fn park(&self) -> Parked<'_> {
        if let Some(parked) = &self.parked {
            parked.fetch_add(1, Ordering::AcqRel);
        }

        Parked(self.parked.as_deref())
    }
}

/// Keeps a command marked as parked for as long as it lives.
struct Parked<'a>(Option<&'a AtomicUsize>);

impl Drop for Parked<'_> {
    fn drop(&mut self) {
        if let Some(parked) = self.0 {
            parked.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

/// Events that were delivered together. Dropping the batch returns its credits.
pub struct EventBatch {
    pub events: Vec<ProcessEvent>,
    credits: Option<Arc<Semaphore>>,
    held: usize,
}

impl Drop for EventBatch {
    fn drop(&mut self) {
        if let Some(credits) = &self.credits {
            credits.add_permits(self.held);
        }
    }
}

/// The receiving half of a run's event stream.
pub struct EventStream {
    rx: mpsc::UnboundedReceiver<ProcessEvent>,
    credits: Option<Arc<Semaphore>>,
}

/// A stream that holds at most `capacity` output events at a time, and the sink that feeds it.
///
/// `capacity` counts events the consumer has not finished with: queued ones and the
/// batch it is processing. It must be at least 1.
pub fn event_channel(capacity: usize) -> (EventSink, EventStream) {
    let (tx, rx) = mpsc::unbounded_channel();
    let credits = Arc::new(Semaphore::new(capacity.max(1)));

    (EventSink { tx, credits: Some(Arc::clone(&credits)), parked: None }, EventStream { rx, credits: Some(credits) })
}

impl Drop for EventStream {
    /// A consumer that goes away must not leave a reader waiting for a credit that will never come.
    fn drop(&mut self) {
        self.close();
    }
}

impl EventStream {
    /// Wait for the next event, then take everything already queued behind it, up to
    /// `max` events in all. There is no timer: a lone event is delivered at once, and a
    /// burst coalesces while the consumer is busy with the previous batch.
    ///
    /// `None` once the stream is closed (or every sink is gone) and nothing is left.
    pub async fn next_batch(&mut self, max: usize) -> Option<EventBatch> {
        let first = self.rx.recv().await?;
        let mut events = vec![first];

        self.fill(&mut events, max);

        Some(self.batch(events))
    }

    /// What is queued right now, without waiting. `None` when nothing is.
    pub fn try_next_batch(&mut self, max: usize) -> Option<EventBatch> {
        let mut events = Vec::new();

        self.fill(&mut events, max);

        (!events.is_empty()).then(|| self.batch(events))
    }

    /// Refuse further events. A sender that is waiting for a credit gives up.
    /// What is already queued can still be taken.
    pub fn close(&mut self) {
        self.rx.close();

        if let Some(credits) = &self.credits {
            credits.close();
        }
    }

    fn fill(&mut self, events: &mut Vec<ProcessEvent>, max: usize) {
        while events.len() < max {
            match self.rx.try_recv() {
                Ok(event) => events.push(event),
                Err(_) => break,
            }
        }
    }

    fn batch(&self, events: Vec<ProcessEvent>) -> EventBatch {
        let held = events.iter().filter(|event| is_output(event)).count();

        EventBatch { events, credits: self.credits.clone(), held }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::time::timeout;

    use super::*;

    fn line(text: &str) -> ProcessEvent {
        ProcessEvent::Stdout { index: 0, text: text.to_string() }
    }

    fn texts(batch: &EventBatch) -> Vec<&str> {
        batch
            .events
            .iter()
            .map(|event| match event {
                ProcessEvent::Stdout { text, .. } => text.as_str(),
                other => other.kind(),
            })
            .collect()
    }

    #[tokio::test]
    async fn a_burst_is_delivered_as_one_batch_in_order() {
        let (sink, mut stream) = event_channel(16);

        for text in ["a", "b", "c"] {
            assert!(sink.send_output(line(text)).await);
        }

        let batch = stream.next_batch(10).await.unwrap();

        assert_eq!(texts(&batch), ["a", "b", "c"]);
    }

    #[tokio::test]
    async fn a_batch_is_capped_and_the_rest_follows_in_order() {
        let (sink, mut stream) = event_channel(16);

        for text in ["a", "b", "c", "d", "e"] {
            sink.send_output(line(text)).await;
        }

        let first = stream.next_batch(2).await.unwrap();
        let second = stream.next_batch(2).await.unwrap();
        let third = stream.next_batch(2).await.unwrap();

        assert_eq!([texts(&first), texts(&second), texts(&third)], [vec!["a", "b"], vec!["c", "d"], vec!["e"]]);
    }

    #[tokio::test]
    async fn lifecycle_events_keep_their_place_between_output_events() {
        let (sink, mut stream) = event_channel(16);

        sink.send(ProcessEvent::Started { index: 0, pid: Some(1) });
        sink.send_output(line("x")).await;
        sink.send(ProcessEvent::Error { index: 0, message: "m".to_string() });

        let batch = stream.next_batch(10).await.unwrap();

        assert_eq!(texts(&batch), ["started", "x", "error"]);
    }

    #[tokio::test]
    async fn a_sender_without_credits_waits_until_the_consumer_is_done_with_a_batch() {
        let (sink, mut stream) = event_channel(2);

        sink.send_output(line("1")).await;
        sink.send_output(line("2")).await;

        let blocked = tokio::spawn({
            let sink = sink.clone();

            async move { sink.send_output(line("3")).await }
        });

        // The third line cannot be queued while two are outstanding.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!blocked.is_finished(), "a sender must wait when the stream is full");

        // Taking the events out is not enough: the consumer still holds them.
        let batch = stream.next_batch(10).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!blocked.is_finished(), "credits come back only when the batch is dropped");

        drop(batch);
        assert!(timeout(Duration::from_secs(1), blocked).await.unwrap().unwrap());
        assert_eq!(texts(&stream.next_batch(10).await.unwrap()), ["3"]);
    }

    #[tokio::test]
    async fn lifecycle_events_never_wait_for_credits() {
        let (sink, mut stream) = event_channel(1);

        sink.send_output(line("1")).await;

        // The stream is full of output, and a close must still go through.
        assert!(sink.send(ProcessEvent::Close {
            index: 0,
            exit_code: 0,
            killed: false,
            command_name: None,
            duration_ms: 0.0,
        }));
        assert_eq!(texts(&stream.next_batch(10).await.unwrap()), ["1", "close"]);
    }

    #[tokio::test]
    async fn closing_the_stream_releases_a_waiting_sender() {
        let (sink, mut stream) = event_channel(1);

        sink.send_output(line("1")).await;

        let blocked = tokio::spawn({
            let sink = sink.clone();

            async move { sink.send_output(line("2")).await }
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        stream.close();

        assert!(!timeout(Duration::from_secs(1), blocked).await.unwrap().unwrap(), "the send must report failure");
        assert!(!sink.send(ProcessEvent::Started { index: 0, pid: None }));
        // What was queued before the close can still be taken.
        assert_eq!(texts(&stream.try_next_batch(10).unwrap()), ["1"]);
        assert!(stream.try_next_batch(10).is_none());
    }

    #[tokio::test]
    async fn dropping_the_stream_releases_a_waiting_sender() {
        let (sink, mut stream) = event_channel(1);

        sink.send_output(line("1")).await;

        let blocked = tokio::spawn({
            let sink = sink.clone();

            async move { sink.send_output(line("2")).await }
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        // The first event is still outstanding, so the credit never comes back by itself.
        let batch = stream.next_batch(10).await.unwrap();
        std::mem::forget(batch);
        drop(stream);

        assert!(!timeout(Duration::from_secs(1), blocked).await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn a_parked_sender_is_counted_while_it_waits() {
        let (sink, mut stream) = event_channel(1);
        let parked = Arc::new(AtomicUsize::new(0));
        let counting = sink.counting_parked(Arc::clone(&parked));

        counting.send_output(line("1")).await;
        assert_eq!(parked.load(Ordering::Acquire), 0);

        let waiting = tokio::spawn({
            let counting = counting.clone();

            async move { counting.send_output(line("2")).await }
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(parked.load(Ordering::Acquire), 1);

        drop(stream.next_batch(10).await.unwrap());
        waiting.await.unwrap();
        assert_eq!(parked.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn a_bare_channel_converts_into_an_unbounded_sink() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sink = EventSink::from(tx);

        for _ in 0..1000 {
            assert!(sink.send_output(line("x")).await);
        }

        let mut count = 0;

        while rx.try_recv().is_ok() {
            count += 1;
        }

        assert_eq!(count, 1000);
    }
}
