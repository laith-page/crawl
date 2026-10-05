use super::retry_after;

#[test]
fn a_retry_after_of_too_many_digits_is_the_longest_wait_not_an_invalid_one() {
    assert_eq!(retry_after("120"), Some(120));
    assert_eq!(retry_after("18446744073709551615"), Some(u64::MAX));
    assert_eq!(retry_after("18446744073709551616"), Some(u64::MAX));
    assert_eq!(retry_after(&"9".repeat(10_000)), Some(u64::MAX));
    for value in ["", "1.5", "-1", "+1", " 1", "Wed, 21 Oct 2099 07:28:00 GMT"] {
        assert_eq!(retry_after(value), None, "{value}");
    }
}
