use super::*;

#[tokio::test]
async fn concurrent_requests_span_two_delays() {
    let throttle = Throttle::new(20, true);
    let begun = Instant::now();
    let (first, second, third) = tokio::join!(throttle.start(), throttle.start(), throttle.start());
    assert!(first && second && third);
    assert!(begun.elapsed() >= Duration::from_millis(40));
}

#[tokio::test]
async fn retry_pause_delays_next_request() {
    let throttle = Throttle::new(0, true);
    assert!(throttle.start().await);
    let begun = Instant::now();
    throttle.pause(Duration::from_millis(30));
    throttle.pause(Duration::from_millis(1));
    assert!(throttle.start().await);
    assert!(begun.elapsed() >= Duration::from_millis(30));
}
