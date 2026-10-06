use super::*;

#[test]
fn cpus_overrides() {
    let machine = Machine::detect(4);
    assert_eq!(machine.cpus, 4);
    assert_eq!(machine.threads, 3);
    assert_eq!(machine.max_concurrency, 72);
}

#[test]
fn derives_threads_and_max_concurrency() {
    let machine8 = Machine::detect(8);
    assert_eq!(machine8.cpus, 8);
    assert_eq!(machine8.threads, 7);
    assert_eq!(machine8.max_concurrency, 168);

    let machine2 = Machine::detect(2);
    assert_eq!(machine2.cpus, 2);
    assert_eq!(machine2.threads, 2);
    assert_eq!(machine2.max_concurrency, 48);

    let machine1 = Machine::detect(1);
    assert_eq!(machine1.cpus, 1);
    assert_eq!(machine1.threads, 1);
    assert_eq!(machine1.max_concurrency, 24);
}
