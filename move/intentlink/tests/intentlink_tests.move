/// One test per abort code, plus the behaviours that are easy to get subtly
/// wrong: the window roll, the atomic sweep on revoke, and the fact that a
/// permit lifts exactly two bounds and no others.
///
/// Abort codes are referenced numerically because Move constants are
/// module-private. The mapping:
///
///    1 NOT_ISSUER          11 NOT_CLAIMED         21 OVER_HARD_CAP
///    2 REVOKED             12 NOT_HOLDER          22 POOL_NOT_SCOPED
///    3 VAULT_MISMATCH      13 PAUSED              23 SLIPPAGE
///    4 INSUFFICIENT_VAULT  14 SURRENDERED         24 WRONG_BENEFICIARY
///    5 ALREADY_CLAIMED     15 NOT_YET             25 ZERO_AMOUNT
///    6 BAD_BENEFICIARY     16 EXPIRED             26 NOT_PRINCIPAL
///    7 BAD_CAPS            17 WINDOWS_EXHAUSTED   27 PERMIT_WRONG_CAPSULE
///    8 BAD_WINDOW          18 OVER_ACTION_CAP     28 PERMIT_EXPIRED
///    9 BAD_LIFETIME        19 OVER_WINDOW_CAP     29 PERMIT_AMOUNT
///   10 WRONG_RECIPIENT     20 OVER_TOTAL_CAP
#[test_only]
module intentlink::intentlink_tests;

use intentlink::intentlink::{Self as il, Vault, Capsule, VerifierCap, Permit};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const ISSUER: address = @0xA11CE;
const PRINCIPAL: address = @0xB0B;
const AGENT: address = @0xA6E17;
const OUTSIDER: address = @0xBAD;

const POOL_OK: address = @0x900D;
const POOL_BAD: address = @0x0FF5;

const DAY: u64 = 86_400_000;

const VAULT_FUNDS: u64 = 600;
const PER_ACTION: u64 = 20;
const PER_WINDOW: u64 = 20;
const TOTAL: u64 = 600;
const HARD: u64 = 250;
const MAX_WINDOWS: u64 = 30;
const SLIPPAGE_BPS: u64 = 100;

// ===== Harness ====================================================

fun pool_ok(): ID { object::id_from_address(POOL_OK) }

fun pool_bad(): ID { object::id_from_address(POOL_BAD) }

/// Vault funded, capsule minted, not yet claimed. `bound` is the optional
/// salted recipient hash; `max_windows` and `expires_at` vary per test.
fun start_with(
    bound: Option<vector<u8>>,
    max_windows: u64,
    expires_at: u64,
): (Scenario, Clock) {
    let mut sc = ts::begin(ISSUER);
    il::init_for_testing(sc.ctx());

    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ISSUER);
    {
        let funds = coin::mint_for_testing<SUI>(VAULT_FUNDS, sc.ctx());
        il::create_vault(funds, sc.ctx());
    };

    sc.next_tx(ISSUER);
    {
        let vault = sc.take_shared<Vault<SUI>>();
        il::mint_capsule(
            &vault,
            bound,
            b"issuer-nullifier",
            PER_ACTION,
            TOTAL,
            HARD,
            DAY,
            PER_WINDOW,
            max_windows,
            vector[pool_ok()],
            SLIPPAGE_BPS,
            1, // BENEFICIARY_PRINCIPAL
            option::none(),
            0,
            expires_at,
            b"ens-node",
            b"policy-hash",
            sc.ctx(),
        );
        ts::return_shared(vault);
    };

    (sc, clock)
}

/// Vault funded, capsule minted with the standard policy, not yet claimed.
fun start(): (Scenario, Clock) {
    start_with(option::none(), MAX_WINDOWS, 30 * DAY)
}

fun claim_as(sc: &mut Scenario, clock: &Clock, principal: address, holder: address) {
    sc.next_tx(ISSUER);
    let cap = sc.take_from_sender<VerifierCap>();
    let mut capsule = sc.take_shared<Capsule>();
    il::claim(&cap, &mut capsule, principal, holder, option::none(), clock);
    ts::return_shared(capsule);
    sc.return_to_sender(cap);
}

/// As `start`, then redeemed by PRINCIPAL with AGENT as the acting key.
fun start_claimed(): (Scenario, Clock) {
    let (mut sc, clock) = start();
    sc.next_tx(ISSUER);
    {
        let cap = sc.take_from_sender<VerifierCap>();
        let mut capsule = sc.take_shared<Capsule>();
        il::claim(&cap, &mut capsule, PRINCIPAL, AGENT, option::none(), &clock);
        ts::return_shared(capsule);
        sc.return_to_sender(cap);
    };
    (sc, clock)
}

/// Run `execute` as AGENT with the standard good arguments, overriding
/// amount only.
fun exec(sc: &mut Scenario, clock: &Clock, amount: u64) {
    sc.next_tx(AGENT);
    let mut vault = sc.take_shared<Vault<SUI>>();
    let mut capsule = sc.take_shared<Capsule>();
    il::execute(
        &mut vault, &mut capsule, clock,
        amount, PRINCIPAL, pool_ok(), SLIPPAGE_BPS,
        sc.ctx(),
    );
    ts::return_shared(vault);
    ts::return_shared(capsule);
}

fun finish(sc: Scenario, clock: Clock) {
    clock::destroy_for_testing(clock);
    sc.end();
}

// ===== Happy path =================================================

#[test]
fun executes_within_bounds() {
    let (mut sc, clock) = start_claimed();
    exec(&mut sc, &clock, 12);

    sc.next_tx(PRINCIPAL);
    {
        let capsule = sc.take_shared<Capsule>();
        assert!(il::capsule_spent(&capsule) == 12, 0);
        assert!(il::capsule_window_spent(&capsule) == 12, 1);
        assert!(il::capsule_windows_used(&capsule) == 1, 2);
        assert!(il::capsule_window_remaining(&capsule) == 8, 3);
        ts::return_shared(capsule);

        // beneficiary is PRINCIPAL, so the coin landed with them
        let paid = sc.take_from_sender<Coin<SUI>>();
        assert!(paid.value() == 12, 4);
        sc.return_to_sender(paid);
    };
    finish(sc, clock);
}

#[test]
fun vault_debited_by_exact_amount() {
    let (mut sc, clock) = start_claimed();
    exec(&mut sc, &clock, 20);

    sc.next_tx(ISSUER);
    {
        let vault = sc.take_shared<Vault<SUI>>();
        assert!(il::vault_balance(&vault) == VAULT_FUNDS - 20, 0);
        ts::return_shared(vault);
    };
    finish(sc, clock);
}

// ===== The bounds =================================================

#[test]
#[expected_failure(abort_code = 18, location = intentlink::intentlink)]
fun rejects_over_per_action_cap() {
    let (mut sc, clock) = start_claimed();
    exec(&mut sc, &clock, PER_ACTION + 1);
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 19, location = intentlink::intentlink)]
fun rejects_over_window_cap_across_two_actions() {
    let (mut sc, clock) = start_claimed();
    exec(&mut sc, &clock, 12); // ok
    exec(&mut sc, &clock, 12); // 24 > 20 in the same window
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 22, location = intentlink::intentlink)]
fun rejects_out_of_scope_pool() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(AGENT);
    let mut vault = sc.take_shared<Vault<SUI>>();
    let mut capsule = sc.take_shared<Capsule>();
    il::execute(
        &mut vault, &mut capsule, &clock,
        10, PRINCIPAL, pool_bad(), SLIPPAGE_BPS,
        sc.ctx(),
    );
    ts::return_shared(vault);
    ts::return_shared(capsule);
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 23, location = intentlink::intentlink)]
fun rejects_excess_slippage() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(AGENT);
    let mut vault = sc.take_shared<Vault<SUI>>();
    let mut capsule = sc.take_shared<Capsule>();
    il::execute(
        &mut vault, &mut capsule, &clock,
        10, PRINCIPAL, pool_ok(), SLIPPAGE_BPS + 1,
        sc.ctx(),
    );
    ts::return_shared(vault);
    ts::return_shared(capsule);
    finish(sc, clock);
}

/// The agent runs a perfectly valid trade but tries to keep the proceeds.
#[test]
#[expected_failure(abort_code = 24, location = intentlink::intentlink)]
fun agent_cannot_redirect_proceeds_to_itself() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(AGENT);
    let mut vault = sc.take_shared<Vault<SUI>>();
    let mut capsule = sc.take_shared<Capsule>();
    il::execute(
        &mut vault, &mut capsule, &clock,
        10, AGENT, pool_ok(), SLIPPAGE_BPS,
        sc.ctx(),
    );
    ts::return_shared(vault);
    ts::return_shared(capsule);
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 12, location = intentlink::intentlink)]
fun only_the_holder_may_execute() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(OUTSIDER);
    let mut vault = sc.take_shared<Vault<SUI>>();
    let mut capsule = sc.take_shared<Capsule>();
    il::execute(
        &mut vault, &mut capsule, &clock,
        10, PRINCIPAL, pool_ok(), SLIPPAGE_BPS,
        sc.ctx(),
    );
    ts::return_shared(vault);
    ts::return_shared(capsule);
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 25, location = intentlink::intentlink)]
fun rejects_zero_amount() {
    let (mut sc, clock) = start_claimed();
    exec(&mut sc, &clock, 0);
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 11, location = intentlink::intentlink)]
fun cannot_execute_before_redemption() {
    let (mut sc, clock) = start(); // never claimed
    exec(&mut sc, &clock, 10);
    finish(sc, clock);
}

// ===== Lifetime ===================================================

#[test]
#[expected_failure(abort_code = 16, location = intentlink::intentlink)]
fun rejects_after_expiry() {
    let (mut sc, mut clock) = start_claimed();
    clock.set_for_testing(31 * DAY);
    exec(&mut sc, &clock, 10);
    finish(sc, clock);
}

/// Two windows allowed, but a month before expiry — so running out of
/// windows is what stops it, not the clock.
#[test]
#[expected_failure(abort_code = 17, location = intentlink::intentlink)]
fun rejects_once_windows_are_exhausted() {
    let (mut sc, mut clock) = start_with(option::none(), 2, 30 * DAY);
    claim_as(&mut sc, &clock, PRINCIPAL, AGENT);

    exec(&mut sc, &clock, 1); // window 1
    clock.set_for_testing(DAY + 1);
    exec(&mut sc, &clock, 1); // window 2
    clock.set_for_testing(2 * DAY + 1);
    exec(&mut sc, &clock, 1); // window 3 — none left
    finish(sc, clock);
}

// ===== Recurrence =================================================

/// The beat the demo hangs on: blocked now, the same action clears once the
/// window rolls.
#[test]
fun window_rolls_and_the_same_action_then_clears() {
    let (mut sc, mut clock) = start_claimed();

    exec(&mut sc, &clock, 20); // window 1 fully spent

    clock.set_for_testing(DAY + 1);
    exec(&mut sc, &clock, 20); // would abort a moment ago

    sc.next_tx(PRINCIPAL);
    {
        let capsule = sc.take_shared<Capsule>();
        assert!(il::capsule_spent(&capsule) == 40, 0);
        assert!(il::capsule_window_spent(&capsule) == 20, 1);
        assert!(il::capsule_windows_used(&capsule) == 2, 2);
        ts::return_shared(capsule);
    };
    finish(sc, clock);
}

/// Unused windows are consumed, not banked. Skipping days 2-4 does not make
/// day 5 worth four days of budget.
#[test]
fun skipped_windows_are_not_banked() {
    let (mut sc, mut clock) = start_claimed();
    exec(&mut sc, &clock, 5); // window 1

    clock.set_for_testing(4 * DAY + 1); // skip ahead four windows
    exec(&mut sc, &clock, 20);

    sc.next_tx(PRINCIPAL);
    {
        let capsule = sc.take_shared<Capsule>();
        assert!(il::capsule_windows_used(&capsule) == 5, 0);
        assert!(il::capsule_window_spent(&capsule) == 20, 1);
        ts::return_shared(capsule);
    };
    finish(sc, clock);
}

/// Rolling does not make the new window unlimited — it gets the same cap.
#[test]
#[expected_failure(abort_code = 19, location = intentlink::intentlink)]
fun a_rolled_window_still_has_its_own_cap() {
    let (mut sc, mut clock) = start_claimed();
    exec(&mut sc, &clock, 20);
    clock.set_for_testing(DAY + 1);
    exec(&mut sc, &clock, 12); // fine in the fresh window
    exec(&mut sc, &clock, 12); // 24 > 20, same as day one
    finish(sc, clock);
}

// ===== Revocation, pause, surrender ===============================

#[test]
fun revoke_kills_the_capability_and_sweeps_in_one_transaction() {
    let (mut sc, clock) = start_claimed();
    exec(&mut sc, &clock, 20);

    sc.next_tx(ISSUER);
    {
        let mut vault = sc.take_shared<Vault<SUI>>();
        il::revoke_vault(&mut vault, sc.ctx());
        assert!(il::vault_balance(&vault) == 0, 0);
        assert!(il::vault_revoked(&vault), 1);
        ts::return_shared(vault);
    };

    sc.next_tx(ISSUER);
    {
        // the unspent remainder came back in the same call
        let returned = sc.take_from_sender<Coin<SUI>>();
        assert!(returned.value() == VAULT_FUNDS - 20, 2);
        sc.return_to_sender(returned);
    };
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 2, location = intentlink::intentlink)]
fun cannot_execute_after_revocation() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(ISSUER);
    {
        let mut vault = sc.take_shared<Vault<SUI>>();
        il::revoke_vault(&mut vault, sc.ctx());
        ts::return_shared(vault);
    };
    exec(&mut sc, &clock, 10);
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 13, location = intentlink::intentlink)]
fun principal_can_pause_without_the_issuer() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(PRINCIPAL);
    {
        let mut capsule = sc.take_shared<Capsule>();
        il::set_principal_pause(&mut capsule, true, &clock, sc.ctx());
        ts::return_shared(capsule);
    };
    exec(&mut sc, &clock, 10);
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 13, location = intentlink::intentlink)]
fun issuer_unpausing_does_not_clear_a_principal_pause() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(PRINCIPAL);
    {
        let mut capsule = sc.take_shared<Capsule>();
        il::set_principal_pause(&mut capsule, true, &clock, sc.ctx());
        ts::return_shared(capsule);
    };
    sc.next_tx(ISSUER);
    {
        let mut capsule = sc.take_shared<Capsule>();
        il::set_issuer_pause(&mut capsule, false, &clock, sc.ctx());
        ts::return_shared(capsule);
    };
    exec(&mut sc, &clock, 10); // still paused
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 14, location = intentlink::intentlink)]
fun surrender_ends_the_capability() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(PRINCIPAL);
    {
        let mut capsule = sc.take_shared<Capsule>();
        il::surrender(&mut capsule, &clock, sc.ctx());
        ts::return_shared(capsule);
    };
    exec(&mut sc, &clock, 10);
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 26, location = intentlink::intentlink)]
fun outsider_cannot_surrender() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(OUTSIDER);
    {
        let mut capsule = sc.take_shared<Capsule>();
        il::surrender(&mut capsule, &clock, sc.ctx());
        ts::return_shared(capsule);
    };
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 1, location = intentlink::intentlink)]
fun only_the_issuer_may_withdraw() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(AGENT);
    {
        let mut vault = sc.take_shared<Vault<SUI>>();
        let c = il::withdraw(&mut vault, 100, sc.ctx());
        transfer::public_transfer(c, AGENT);
        ts::return_shared(vault);
    };
    finish(sc, clock);
}

// ===== Cap reduction ==============================================

#[test]
#[expected_failure(abort_code = 19, location = intentlink::intentlink)]
fun principal_can_tighten_their_own_bounds() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(PRINCIPAL);
    {
        let mut capsule = sc.take_shared<Capsule>();
        // per-action untouched, window tightened to 5
        il::reduce_caps(&mut capsule, PER_ACTION, 5, TOTAL, &clock, sc.ctx());
        ts::return_shared(capsule);
    };
    exec(&mut sc, &clock, 10); // was fine, now over the tightened window cap
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 7, location = intentlink::intentlink)]
fun reduce_caps_cannot_widen() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(ISSUER);
    {
        let mut capsule = sc.take_shared<Capsule>();
        il::reduce_caps(&mut capsule, PER_ACTION + 1, PER_WINDOW, TOTAL, &clock, sc.ctx());
        ts::return_shared(capsule);
    };
    finish(sc, clock);
}

// ===== Redemption =================================================

#[test]
#[expected_failure(abort_code = 5, location = intentlink::intentlink)]
fun a_capsule_can_only_be_redeemed_once() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(ISSUER);
    {
        let cap = sc.take_from_sender<VerifierCap>();
        let mut capsule = sc.take_shared<Capsule>();
        il::claim(&cap, &mut capsule, OUTSIDER, OUTSIDER, option::none(), &clock);
        ts::return_shared(capsule);
        sc.return_to_sender(cap);
    };
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 10, location = intentlink::intentlink)]
fun bound_capsule_rejects_the_wrong_recipient() {
    let mut sc = ts::begin(ISSUER);
    il::init_for_testing(sc.ctx());
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ISSUER);
    {
        let funds = coin::mint_for_testing<SUI>(VAULT_FUNDS, sc.ctx());
        il::create_vault(funds, sc.ctx());
    };
    sc.next_tx(ISSUER);
    {
        let vault = sc.take_shared<Vault<SUI>>();
        il::mint_capsule(
            &vault,
            option::some(b"hash-of-alice-email"), // bound
            b"issuer-nullifier",
            PER_ACTION, TOTAL, HARD, DAY, PER_WINDOW, MAX_WINDOWS,
            vector[pool_ok()], SLIPPAGE_BPS, 1, option::none(),
            0, 30 * DAY, b"ens-node", b"policy-hash",
            sc.ctx(),
        );
        ts::return_shared(vault);
    };
    sc.next_tx(ISSUER);
    {
        let cap = sc.take_from_sender<VerifierCap>();
        let mut capsule = sc.take_shared<Capsule>();
        il::claim(
            &cap, &mut capsule, OUTSIDER, AGENT,
            option::some(b"hash-of-carol-email"), // different human
            &clock,
        );
        ts::return_shared(capsule);
        sc.return_to_sender(cap);
    };
    finish(sc, clock);
}

// ===== Escalation =================================================

#[test]
fun a_permit_lifts_the_window_cap_for_exactly_one_action() {
    let (mut sc, clock) = start_claimed();
    exec(&mut sc, &clock, 20); // window exhausted

    sc.next_tx(ISSUER);
    {
        let vcap = sc.take_from_sender<VerifierCap>();
        let capsule = sc.take_shared<Capsule>();
        il::mint_permit(&vcap, &capsule, 60, 120_000, b"signal", &clock, sc.ctx());
        ts::return_shared(capsule);
        sc.return_to_sender(vcap);
    };

    sc.next_tx(AGENT);
    {
        let permit = sc.take_from_sender<Permit>();
        let mut vault = sc.take_shared<Vault<SUI>>();
        let mut capsule = sc.take_shared<Capsule>();
        il::execute_elevated(
            &mut vault, &mut capsule, permit, &clock,
            60, PRINCIPAL, pool_ok(), SLIPPAGE_BPS,
            sc.ctx(),
        );
        assert!(il::capsule_spent(&capsule) == 80, 0);
        // the elevated amount is still booked against the window
        assert!(il::capsule_window_spent(&capsule) == 80, 1);
        ts::return_shared(vault);
        ts::return_shared(capsule);
    };
    finish(sc, clock);
}

/// The lift applies to one action. An escalated spend is still charged to
/// the window, so the rest of that window stays closed rather than becoming
/// a fresh allowance.
#[test]
#[expected_failure(abort_code = 19, location = intentlink::intentlink)]
fun an_escalated_spend_still_consumes_the_window() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(ISSUER);
    {
        let vcap = sc.take_from_sender<VerifierCap>();
        let capsule = sc.take_shared<Capsule>();
        il::mint_permit(&vcap, &capsule, 60, 120_000, b"signal", &clock, sc.ctx());
        ts::return_shared(capsule);
        sc.return_to_sender(vcap);
    };
    sc.next_tx(AGENT);
    {
        let permit = sc.take_from_sender<Permit>();
        let mut vault = sc.take_shared<Vault<SUI>>();
        let mut capsule = sc.take_shared<Capsule>();
        il::execute_elevated(
            &mut vault, &mut capsule, permit, &clock,
            60, PRINCIPAL, pool_ok(), SLIPPAGE_BPS,
            sc.ctx(),
        );
        ts::return_shared(vault);
        ts::return_shared(capsule);
    };
    exec(&mut sc, &clock, 1); // window is spent well past its cap
    finish(sc, clock);
}

/// A permit can raise the ceiling but never past the hard cap the issuer set
/// while thinking clearly.
#[test]
#[expected_failure(abort_code = 21, location = intentlink::intentlink)]
fun a_permit_cannot_be_minted_above_the_hard_cap() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(ISSUER);
    {
        let vcap = sc.take_from_sender<VerifierCap>();
        let capsule = sc.take_shared<Capsule>();
        il::mint_permit(&vcap, &capsule, HARD + 1, 120_000, b"signal", &clock, sc.ctx());
        ts::return_shared(capsule);
        sc.return_to_sender(vcap);
    };
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 29, location = intentlink::intentlink)]
fun cannot_spend_more_than_the_permit_allows() {
    let (mut sc, clock) = start_claimed();
    sc.next_tx(ISSUER);
    {
        let vcap = sc.take_from_sender<VerifierCap>();
        let capsule = sc.take_shared<Capsule>();
        il::mint_permit(&vcap, &capsule, 40, 120_000, b"signal", &clock, sc.ctx());
        ts::return_shared(capsule);
        sc.return_to_sender(vcap);
    };
    sc.next_tx(AGENT);
    {
        let permit = sc.take_from_sender<Permit>();
        let mut vault = sc.take_shared<Vault<SUI>>();
        let mut capsule = sc.take_shared<Capsule>();
        il::execute_elevated(
            &mut vault, &mut capsule, permit, &clock,
            41, PRINCIPAL, pool_ok(), SLIPPAGE_BPS,
            sc.ctx(),
        );
        ts::return_shared(vault);
        ts::return_shared(capsule);
    };
    finish(sc, clock);
}

#[test]
#[expected_failure(abort_code = 28, location = intentlink::intentlink)]
fun an_expired_permit_is_worthless() {
    let (mut sc, mut clock) = start_claimed();
    sc.next_tx(ISSUER);
    {
        let vcap = sc.take_from_sender<VerifierCap>();
        let capsule = sc.take_shared<Capsule>();
        il::mint_permit(&vcap, &capsule, 60, 120_000, b"signal", &clock, sc.ctx());
        ts::return_shared(capsule);
        sc.return_to_sender(vcap);
    };
    clock.set_for_testing(200_000); // past the 2 minute ttl
    sc.next_tx(AGENT);
    {
        let permit = sc.take_from_sender<Permit>();
        let mut vault = sc.take_shared<Vault<SUI>>();
        let mut capsule = sc.take_shared<Capsule>();
        il::execute_elevated(
            &mut vault, &mut capsule, permit, &clock,
            30, PRINCIPAL, pool_ok(), SLIPPAGE_BPS,
            sc.ctx(),
        );
        ts::return_shared(vault);
        ts::return_shared(capsule);
    };
    finish(sc, clock);
}

/// An escalation does not lift the hard cap either, even with a permit whose
/// ceiling is legal.
#[test]
#[expected_failure(abort_code = 20, location = intentlink::intentlink)]
fun escalation_still_respects_the_total_cap() {
    let mut sc = ts::begin(ISSUER);
    il::init_for_testing(sc.ctx());
    let clock = clock::create_for_testing(sc.ctx());

    sc.next_tx(ISSUER);
    {
        let funds = coin::mint_for_testing<SUI>(1000, sc.ctx());
        il::create_vault(funds, sc.ctx());
    };
    sc.next_tx(ISSUER);
    {
        let vault = sc.take_shared<Vault<SUI>>();
        // total cap of 30 is the binding constraint, not the window
        il::mint_capsule(
            &vault, option::none(), b"n",
            20, 30, 250, DAY, 20, MAX_WINDOWS,
            vector[pool_ok()], SLIPPAGE_BPS, 1, option::none(),
            0, 30 * DAY, b"e", b"p",
            sc.ctx(),
        );
        ts::return_shared(vault);
    };
    sc.next_tx(ISSUER);
    {
        let vcap = sc.take_from_sender<VerifierCap>();
        let mut capsule = sc.take_shared<Capsule>();
        il::claim(&vcap, &mut capsule, PRINCIPAL, AGENT, option::none(), &clock);
        il::mint_permit(&vcap, &capsule, 100, 120_000, b"signal", &clock, sc.ctx());
        ts::return_shared(capsule);
        sc.return_to_sender(vcap);
    };
    sc.next_tx(AGENT);
    {
        let permit = sc.take_from_sender<Permit>();
        let mut vault = sc.take_shared<Vault<SUI>>();
        let mut capsule = sc.take_shared<Capsule>();
        il::execute_elevated(
            &mut vault, &mut capsule, permit, &clock,
            100, PRINCIPAL, pool_ok(), SLIPPAGE_BPS,
            sc.ctx(),
        );
        ts::return_shared(vault);
        ts::return_shared(capsule);
    };
    finish(sc, clock);
}

// A permit cannot be replayed, and there is deliberately no test for it:
// `Permit` has no `drop` and no `copy`, and `execute_elevated` takes it by
// value. A second use does not fail at runtime — it fails to compile.
