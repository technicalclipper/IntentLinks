/// IntentLink — a link that carries a permission.
///
/// A `Vault` holds the issuer's funds. A `Capsule` is a bounded, revocable
/// permission to spend from that vault. The agent holding a capsule can never
/// exceed its bounds, leave its scope, redirect its proceeds, or act after
/// revocation — not because it behaves, but because these functions abort.
module intentlink::intentlink;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;

// ===== Errors =====================================================

const E_NOT_ISSUER: u64 = 1;
const E_REVOKED: u64 = 2;
const E_VAULT_MISMATCH: u64 = 3;
const E_INSUFFICIENT_VAULT: u64 = 4;
const E_ALREADY_CLAIMED: u64 = 5;
const E_BAD_BENEFICIARY_MODE: u64 = 6;
const E_BAD_CAPS: u64 = 7;
const E_BAD_WINDOW: u64 = 8;
const E_BAD_LIFETIME: u64 = 9;

// --- the bounds. every one of these is a demo beat. ---------------

const E_WRONG_RECIPIENT: u64 = 10;
const E_NOT_CLAIMED: u64 = 11;
const E_NOT_HOLDER: u64 = 12;
const E_PAUSED: u64 = 13;
const E_SURRENDERED: u64 = 14;
const E_NOT_YET: u64 = 15;
const E_EXPIRED: u64 = 16;
const E_WINDOWS_EXHAUSTED: u64 = 17;
const E_OVER_ACTION_CAP: u64 = 18;
const E_OVER_WINDOW_CAP: u64 = 19;
const E_OVER_TOTAL_CAP: u64 = 20;
const E_OVER_HARD_CAP: u64 = 21;
const E_POOL_NOT_SCOPED: u64 = 22;
const E_SLIPPAGE: u64 = 23;
const E_WRONG_BENEFICIARY: u64 = 24;
const E_ZERO_AMOUNT: u64 = 25;
const E_NOT_PRINCIPAL: u64 = 26;
const E_PERMIT_WRONG_CAPSULE: u64 = 27;
const E_PERMIT_EXPIRED: u64 = 28;
const E_PERMIT_AMOUNT: u64 = 29;

// ===== Settlement modes ===========================================

/// Proceeds return to the vault — the issuer is having an agent manage
/// their own money. Revocation returns everything.
const BENEFICIARY_VAULT: u8 = 0;
/// Proceeds go to the redeeming human. The issuer is sending them value;
/// revocation only reclaims what is still unspent.
const BENEFICIARY_PRINCIPAL: u8 = 1;
/// Proceeds go to a fixed address chosen at mint.
const BENEFICIARY_FIXED: u8 = 2;

// ===== Objects ====================================================

/// Shared. Holds the funds. The agent never owns this and never owns the
/// coins inside it — it only ever holds permission to call into it.
public struct Vault<phantom T> has key {
    id: UID,
    funder: address,
    balance: Balance<T>,
    revoked: bool,
}

/// Shared. The capability itself.
///
/// Deliberately has `key` only — no `store`. A shared object cannot be
/// transferred, so the permission cannot be sold, wrapped, or handed on
/// outside the sub-delegation path.
///
/// Access control is by field, not by ownership:
///   - `issuer`    set at mint, may revoke / pause / top up / widen
///   - `principal` set at redemption, the accountable human, may pause / surrender
///   - `holder`    set at redemption, the agent's own key, the only address
///                 that may execute
public struct Capsule has key {
    id: UID,
    vault_id: ID,
    issuer: address,

    // --- binding -------------------------------------------------
    /// Salted hash of the recipient's normalised email. `none` = bearer:
    /// the first verified human to redeem claims it.
    bound_recipient: Option<vector<u8>>,
    /// World ID nullifier of the issuer, committed at mint.
    issuer_nullifier: vector<u8>,
    /// The redeeming human's zkLogin address. Accountable party.
    principal: Option<address>,
    /// The agent's long-lived key. zkLogin sessions expire within days, so a
    /// 30-day agent cannot sign as the principal — it needs its own address.
    holder: Option<address>,

    // --- spend bounds --------------------------------------------
    per_action_cap: u64,
    total_cap: u64,
    /// Absolute ceiling. Never exceeded by any path, including an approved
    /// escalation. Set once, at mint, by a calm issuer.
    hard_cap: u64,
    spent: u64,

    // --- recurrence ----------------------------------------------
    /// Length of one budget window in ms. A total cap alone is not enough:
    /// without a window the agent spends 30 days of budget on day one.
    window_ms: u64,
    per_window_cap: u64,
    max_windows: u64,
    window_start_ms: u64,
    window_spent: u64,
    windows_used: u64,

    // --- scope ---------------------------------------------------
    /// Scoped to object IDs, not addresses.
    allowed_pools: vector<ID>,
    max_slippage_bps: u64,

    // --- settlement ----------------------------------------------
    beneficiary_mode: u8,
    beneficiary_addr: Option<address>,

    // --- lifetime ------------------------------------------------
    not_before: u64,
    expires_at: u64,

    // --- control -------------------------------------------------
    /// Either party may pause. Resuming requires both to be false —
    /// either side can shrink the capability, only the issuer can grant it.
    issuer_paused: bool,
    principal_paused: bool,
    /// Killed by the issuer, without tearing down the whole vault.
    revoked: bool,
    /// Handed back by the principal. A standing 30-day authority is a
    /// liability to hold; a clean exit is what makes it acceptable to accept.
    surrendered: bool,

    // --- cross-chain linkage -------------------------------------
    /// ENS namehash of the subname that publishes this capsule.
    ens_node: vector<u8>,
    /// Hash of the canonical policy JSON. The agent resolves the ENS record
    /// and halts unless it matches this value — ENS and Sui must agree.
    policy_hash: vector<u8>,
}

/// Authority held by the backend that verifies World ID proofs and Google
/// id_tokens. Gates redemption and escalation-permit minting.
///
/// Making it an object states the trust boundary out loud: this key can
/// attest that a human was verified. It cannot move funds, widen a bound,
/// or exceed a hard cap — so a compromised backend is contained by the
/// asserts rather than being game over.
public struct VerifierCap has key, store {
    id: UID,
}

/// One-shot authority to exceed a soft bound, minted only after a fresh
/// World ID proof from the issuer.
///
/// `key` and nothing else — no `store`, no `copy`, and crucially no `drop`.
/// `execute_elevated` takes it by value and destroys it, so replay is not
/// defended against, it is unrepresentable. Move will not let a Permit be
/// duplicated, stashed for later, or silently discarded.
public struct Permit has key {
    id: UID,
    capsule_id: ID,
    max_amount: u64,
    expires_at: u64,
    /// hash(capsule_id, amount, nonce) from the World ID signal, so the
    /// approval is welded to one request and cannot be reused for another.
    signal_hash: vector<u8>,
}

// ===== Events =====================================================

public struct VaultCreated has copy, drop {
    vault_id: ID,
    funder: address,
    amount: u64,
}

public struct VaultFunded has copy, drop {
    vault_id: ID,
    amount: u64,
    new_balance: u64,
}

public struct Withdrawn has copy, drop {
    vault_id: ID,
    amount: u64,
    new_balance: u64,
}

public struct CapsuleMinted has copy, drop {
    capsule_id: ID,
    vault_id: ID,
    issuer: address,
    bound: bool,
    per_window_cap: u64,
    max_windows: u64,
    expires_at: u64,
    policy_hash: vector<u8>,
}

public struct CapsuleRedeemed has copy, drop {
    capsule_id: ID,
    principal: address,
    holder: address,
    nullifier: vector<u8>,
    at_ms: u64,
}

public struct Executed has copy, drop {
    capsule_id: ID,
    vault_id: ID,
    amount: u64,
    beneficiary: address,
    pool_id: ID,
    window_spent: u64,
    total_spent: u64,
    windows_used: u64,
    elevated: bool,
    at_ms: u64,
}

public struct PermitMinted has copy, drop {
    permit_id: ID,
    capsule_id: ID,
    max_amount: u64,
    expires_at: u64,
    signal_hash: vector<u8>,
}

public struct PermitConsumed has copy, drop {
    capsule_id: ID,
    max_amount: u64,
    amount: u64,
    signal_hash: vector<u8>,
    at_ms: u64,
}

public struct WindowRolled has copy, drop {
    capsule_id: ID,
    window_index: u64,
    window_start_ms: u64,
    available: u64,
}

/// An action the agent chose not to take. Attested by the agent, not
/// enforced by the chain — nothing can make a chain witness a non-action.
/// Executions are enforced; refusals are attested.
public struct Skipped has copy, drop {
    capsule_id: ID,
    reason_code: u8,
    detail: vector<u8>,
    at_ms: u64,
}

public struct VaultRevoked has copy, drop {
    vault_id: ID,
    funder: address,
    returned: u64,
}

public struct CapsuleRevoked has copy, drop {
    capsule_id: ID,
    by: address,
    spent: u64,
    at_ms: u64,
}

public struct PauseChanged has copy, drop {
    capsule_id: ID,
    issuer_paused: bool,
    principal_paused: bool,
    by: address,
    at_ms: u64,
}

public struct Surrendered has copy, drop {
    capsule_id: ID,
    by: address,
    spent: u64,
    at_ms: u64,
}

public struct CapsReduced has copy, drop {
    capsule_id: ID,
    per_action_cap: u64,
    per_window_cap: u64,
    total_cap: u64,
    by: address,
    at_ms: u64,
}

// ===== Init =======================================================

fun init(ctx: &mut TxContext) {
    transfer::transfer(
        VerifierCap { id: object::new(ctx) },
        ctx.sender(),
    );
}

// ===== Vault ======================================================

/// Create and share a vault, funded with `initial`.
public fun create_vault<T>(initial: Coin<T>, ctx: &mut TxContext): ID {
    let amount = initial.value();
    let vault = Vault<T> {
        id: object::new(ctx),
        funder: ctx.sender(),
        balance: initial.into_balance(),
        revoked: false,
    };
    let vault_id = object::id(&vault);

    event::emit(VaultCreated { vault_id, funder: ctx.sender(), amount });
    transfer::share_object(vault);
    vault_id
}

/// Top up mid-flight. Issuer only.
public fun fund_vault<T>(vault: &mut Vault<T>, more: Coin<T>, ctx: &TxContext) {
    assert!(vault.funder == ctx.sender(), E_NOT_ISSUER);
    assert!(!vault.revoked, E_REVOKED);

    let amount = more.value();
    vault.balance.join(more.into_balance());

    event::emit(VaultFunded {
        vault_id: object::id(vault),
        amount,
        new_balance: vault.balance.value(),
    });
}

/// Withdraw from the vault. Issuer only — the agent has no path to this,
/// which is what makes "the agent holds authority, never funds" true.
public fun withdraw<T>(vault: &mut Vault<T>, amount: u64, ctx: &mut TxContext): Coin<T> {
    assert!(vault.funder == ctx.sender(), E_NOT_ISSUER);
    assert!(vault.balance.value() >= amount, E_INSUFFICIENT_VAULT);

    let out = coin::take(&mut vault.balance, amount, ctx);

    event::emit(Withdrawn {
        vault_id: object::id(vault),
        amount,
        new_balance: vault.balance.value(),
    });
    out
}

// ===== Capsule ====================================================

/// Mint an unclaimed capsule against a vault. Issuer only.
///
/// The capsule is shared rather than owned: the issuer, the redeeming human,
/// and the agent all need to call into it, and sharing makes it
/// untransferable by construction.
#[allow(lint(share_owned))]
public fun mint_capsule<T>(
    vault: &Vault<T>,
    bound_recipient: Option<vector<u8>>,
    issuer_nullifier: vector<u8>,
    per_action_cap: u64,
    total_cap: u64,
    hard_cap: u64,
    window_ms: u64,
    per_window_cap: u64,
    max_windows: u64,
    allowed_pools: vector<ID>,
    max_slippage_bps: u64,
    beneficiary_mode: u8,
    beneficiary_addr: Option<address>,
    not_before: u64,
    expires_at: u64,
    ens_node: vector<u8>,
    policy_hash: vector<u8>,
    ctx: &mut TxContext,
): ID {
    assert!(vault.funder == ctx.sender(), E_NOT_ISSUER);
    assert!(!vault.revoked, E_REVOKED);

    // A per-action cap above the hard cap would be a lie on the review screen.
    assert!(per_action_cap <= hard_cap, E_BAD_CAPS);
    assert!(per_window_cap <= total_cap, E_BAD_CAPS);
    assert!(window_ms > 0 && max_windows > 0, E_BAD_WINDOW);
    assert!(expires_at > not_before, E_BAD_LIFETIME);
    assert!(
        beneficiary_mode == BENEFICIARY_VAULT
            || beneficiary_mode == BENEFICIARY_PRINCIPAL
            || beneficiary_mode == BENEFICIARY_FIXED,
        E_BAD_BENEFICIARY_MODE,
    );
    // A fixed beneficiary needs an address; the other modes resolve at runtime.
    assert!(
        (beneficiary_mode == BENEFICIARY_FIXED) == beneficiary_addr.is_some(),
        E_BAD_BENEFICIARY_MODE,
    );

    let bound = bound_recipient.is_some();
    let capsule = Capsule {
        id: object::new(ctx),
        vault_id: object::id(vault),
        issuer: ctx.sender(),

        bound_recipient,
        issuer_nullifier,
        principal: option::none(),
        holder: option::none(),

        per_action_cap,
        total_cap,
        hard_cap,
        spent: 0,

        window_ms,
        per_window_cap,
        max_windows,
        window_start_ms: 0, // set on first execution
        window_spent: 0,
        windows_used: 0,

        allowed_pools,
        max_slippage_bps,

        beneficiary_mode,
        beneficiary_addr,

        not_before,
        expires_at,

        issuer_paused: false,
        principal_paused: false,
        revoked: false,
        surrendered: false,

        ens_node,
        policy_hash,
    };
    let capsule_id = object::id(&capsule);

    event::emit(CapsuleMinted {
        capsule_id,
        vault_id: object::id(vault),
        issuer: ctx.sender(),
        bound,
        per_window_cap,
        max_windows,
        expires_at,
        policy_hash,
    });

    transfer::share_object(capsule);
    capsule_id
}

// ===== Redemption =================================================

/// Bind an unclaimed capsule to a human and an agent.
///
/// Gated by `VerifierCap` because the checks that matter happen off-chain:
/// the backend verifies a World ID proof (a unique human) and a Google
/// id_token with `email_verified` (which human). Those two answer different
/// questions and neither substitutes for the other.
///
/// `recipient_hash` is the salted hash of the normalised email. Salted
/// because a bare email hash on a public chain is trivially brute-forced.
public fun claim(
    _cap: &VerifierCap,
    capsule: &mut Capsule,
    principal: address,
    holder: address,
    recipient_hash: Option<vector<u8>>,
    clock: &Clock,
) {
    assert!(capsule.holder.is_none(), E_ALREADY_CLAIMED);
    assert!(!capsule.surrendered, E_SURRENDERED);

    let now = clock.timestamp_ms();
    assert!(now < capsule.expires_at, E_EXPIRED);

    // Bound mode: the presented email hash must match the commitment made at
    // mint. Bearer mode (`bound_recipient` is none) skips this — the first
    // verified human to arrive claims it.
    if (capsule.bound_recipient.is_some()) {
        assert!(recipient_hash.is_some(), E_WRONG_RECIPIENT);
        assert!(
            capsule.bound_recipient.borrow() == recipient_hash.borrow(),
            E_WRONG_RECIPIENT,
        );
    };

    capsule.principal = option::some(principal);
    capsule.holder = option::some(holder);

    event::emit(CapsuleRedeemed {
        capsule_id: object::id(capsule),
        principal,
        holder,
        nullifier: capsule.issuer_nullifier,
        at_ms: now,
    });
}

// ===== Execution ==================================================

/// Advance the budget window if enough time has passed. Returns true if it
/// rolled.
///
/// Unused windows are consumed, not banked: if the agent skips days 2-5,
/// day 6 is still window 6. "20 a day for 30 days" means exactly that, not
/// "600 whenever you like".
fun roll_window(c: &mut Capsule, now: u64): bool {
    // `windows_used`, not `window_start_ms`, is the "never run" sentinel —
    // a genesis-epoch clock makes a zero start time indistinguishable from
    // an unset one, which silently reset the budget on every call.
    if (c.windows_used == 0) {
        c.window_start_ms = now;
        c.window_spent = 0;
        c.windows_used = 1;
        true
    } else if (now >= c.window_start_ms + c.window_ms) {
        let elapsed = (now - c.window_start_ms) / c.window_ms;
        c.window_start_ms = c.window_start_ms + elapsed * c.window_ms;
        c.window_spent = 0;
        c.windows_used = c.windows_used + elapsed;
        true
    } else {
        false
    }
}

/// Where proceeds are allowed to land. Derived from the capsule, never from
/// caller input — the agent gets to *propose* a recipient and be refused,
/// but it cannot widen the set of acceptable ones.
fun resolve_beneficiary(c: &Capsule): address {
    if (c.beneficiary_mode == BENEFICIARY_PRINCIPAL) {
        *c.principal.borrow()
    } else if (c.beneficiary_mode == BENEFICIARY_FIXED) {
        *c.beneficiary_addr.borrow()
    } else {
        // BENEFICIARY_VAULT — the issuer is having an agent manage their own
        // money, so value returns to them.
        c.issuer
    }
}

/// Spend from the vault under the capsule's bounds.
///
/// Every assert below is the product. If the backend were fully compromised
/// it could propose anything it liked here and still not get past them.
public fun execute<T>(
    vault: &mut Vault<T>,
    capsule: &mut Capsule,
    clock: &Clock,
    amount: u64,
    recipient: address,
    pool_id: ID,
    slippage_bps: u64,
    ctx: &mut TxContext,
) {
    execute_inner(
        vault, capsule, clock, amount, recipient, pool_id, slippage_bps,
        option::none(), ctx,
    )
}

/// Spend above a soft bound, consuming a one-shot `Permit`.
///
/// The permit is taken **by value** and destroyed. It lifts the per-action
/// and per-window caps for exactly one action; it lifts nothing else. The
/// hard cap, the total cap, the pool scope, the expiry, the pause flags and
/// the revocation check all still run.
///
/// A permit is a key to one door, not to the building.
public fun execute_elevated<T>(
    vault: &mut Vault<T>,
    capsule: &mut Capsule,
    permit: Permit,
    clock: &Clock,
    amount: u64,
    recipient: address,
    pool_id: ID,
    slippage_bps: u64,
    ctx: &mut TxContext,
) {
    let Permit { id, capsule_id, max_amount, expires_at, signal_hash } = permit;
    object::delete(id); // consumed — there is no second use of this object

    assert!(capsule_id == object::id(capsule), E_PERMIT_WRONG_CAPSULE);
    assert!(clock.timestamp_ms() < expires_at, E_PERMIT_EXPIRED);
    assert!(amount <= max_amount, E_PERMIT_AMOUNT);

    event::emit(PermitConsumed {
        capsule_id,
        max_amount,
        amount,
        signal_hash,
        at_ms: clock.timestamp_ms(),
    });

    execute_inner(
        vault, capsule, clock, amount, recipient, pool_id, slippage_bps,
        option::some(max_amount), ctx,
    )
}

/// Shared execution path. `elevated` carries the permit's ceiling when one
/// was consumed, and is `none` for an ordinary action.
fun execute_inner<T>(
    vault: &mut Vault<T>,
    capsule: &mut Capsule,
    clock: &Clock,
    amount: u64,
    recipient: address,
    pool_id: ID,
    slippage_bps: u64,
    elevated: Option<u64>,
    ctx: &mut TxContext,
) {
    let now = clock.timestamp_ms();

    // --- who is asking -------------------------------------------
    assert!(capsule.vault_id == object::id(vault), E_VAULT_MISMATCH);
    assert!(capsule.holder.is_some(), E_NOT_CLAIMED);
    assert!(*capsule.holder.borrow() == ctx.sender(), E_NOT_HOLDER);

    // --- is the capability alive ---------------------------------
    assert!(!vault.revoked, E_REVOKED);
    assert!(!capsule.revoked, E_REVOKED);
    assert!(!capsule.surrendered, E_SURRENDERED);
    assert!(!capsule.issuer_paused && !capsule.principal_paused, E_PAUSED);
    assert!(now >= capsule.not_before, E_NOT_YET);
    assert!(now < capsule.expires_at, E_EXPIRED);

    // --- recurrence ----------------------------------------------
    let rolled = roll_window(capsule, now);
    assert!(capsule.windows_used <= capsule.max_windows, E_WINDOWS_EXHAUSTED);
    if (rolled) {
        event::emit(WindowRolled {
            capsule_id: object::id(capsule),
            window_index: capsule.windows_used,
            window_start_ms: capsule.window_start_ms,
            available: capsule.per_window_cap,
        });
    };

    // --- how much ------------------------------------------------
    assert!(amount > 0, E_ZERO_AMOUNT);

    // The soft bounds. A permit lifts these two and only these two.
    if (elevated.is_none()) {
        assert!(amount <= capsule.per_action_cap, E_OVER_ACTION_CAP);
        assert!(capsule.window_spent + amount <= capsule.per_window_cap, E_OVER_WINDOW_CAP);
    };

    // The hard bounds. Nothing lifts these — not a permit, not the issuer
    // half-asleep at 3am, not a compromised backend minting permits freely.
    // The ceiling was set once, at mint, by someone who was thinking clearly.
    assert!(amount <= capsule.hard_cap, E_OVER_HARD_CAP);
    assert!(capsule.spent + amount <= capsule.total_cap, E_OVER_TOTAL_CAP);

    // --- where ---------------------------------------------------
    assert!(capsule.allowed_pools.contains(&pool_id), E_POOL_NOT_SCOPED);
    assert!(slippage_bps <= capsule.max_slippage_bps, E_SLIPPAGE);

    // The agent cannot steal the proceeds of an otherwise-valid action.
    assert!(recipient == resolve_beneficiary(capsule), E_WRONG_BENEFICIARY);

    // --- settle --------------------------------------------------
    assert!(vault.balance.value() >= amount, E_INSUFFICIENT_VAULT);

    capsule.window_spent = capsule.window_spent + amount;
    capsule.spent = capsule.spent + amount;

    let payment = coin::take(&mut vault.balance, amount, ctx);
    transfer::public_transfer(payment, recipient);

    event::emit(Executed {
        capsule_id: object::id(capsule),
        vault_id: object::id(vault),
        amount,
        beneficiary: recipient,
        pool_id,
        window_spent: capsule.window_spent,
        total_spent: capsule.spent,
        windows_used: capsule.windows_used,
        elevated: elevated.is_some(),
        at_ms: now,
    });
}

/// Mint a one-shot escalation permit.
///
/// Called only after the backend has verified a fresh World ID proof from
/// the issuer, with the signal bound to this exact request. The agent has no
/// path to this function — it can ask, it cannot approve.
///
/// `max_amount` is clamped to the capsule's hard cap here as well as at
/// execution, so even a compromised verifier cannot mint its way past it.
public fun mint_permit(
    _cap: &VerifierCap,
    capsule: &Capsule,
    max_amount: u64,
    ttl_ms: u64,
    signal_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(capsule.holder.is_some(), E_NOT_CLAIMED);
    assert!(!capsule.revoked && !capsule.surrendered, E_REVOKED);
    assert!(max_amount <= capsule.hard_cap, E_OVER_HARD_CAP);

    let expires_at = clock.timestamp_ms() + ttl_ms;
    let permit = Permit {
        id: object::new(ctx),
        capsule_id: object::id(capsule),
        max_amount,
        expires_at,
        signal_hash,
    };

    event::emit(PermitMinted {
        permit_id: object::id(&permit),
        capsule_id: object::id(capsule),
        max_amount,
        expires_at,
        signal_hash,
    });

    // Straight to the agent. `Permit` has no `store`, so only this module
    // can ever move one.
    transfer::transfer(permit, *capsule.holder.borrow());
}

/// Record that the agent declined to act.
///
/// Attested, not enforced — the chain cannot witness a non-action, and we
/// do not claim otherwise. Only the holder can write to its own log.
public fun log_skip(
    capsule: &Capsule,
    clock: &Clock,
    reason_code: u8,
    detail: vector<u8>,
    ctx: &TxContext,
) {
    assert!(capsule.holder.is_some(), E_NOT_CLAIMED);
    assert!(*capsule.holder.borrow() == ctx.sender(), E_NOT_HOLDER);

    event::emit(Skipped {
        capsule_id: object::id(capsule),
        reason_code,
        detail,
        at_ms: clock.timestamp_ms(),
    });
}

// ===== Control ====================================================
//
// The asymmetry: either party may shrink the capability, only the issuer
// may grant it. Nothing here lets the agent widen its own bounds.

/// Kill the vault and sweep every unspent coin back to the funder, in the
/// same transaction. Every capsule drawing on it dies at the same instant.
///
/// Revocation and refund are one transaction, not a promise followed by a
/// refund process.
public fun revoke_vault<T>(vault: &mut Vault<T>, ctx: &mut TxContext) {
    assert!(vault.funder == ctx.sender(), E_NOT_ISSUER);
    assert!(!vault.revoked, E_REVOKED);

    vault.revoked = true;

    let returned = vault.balance.value();
    if (returned > 0) {
        let sweep = coin::take(&mut vault.balance, returned, ctx);
        transfer::public_transfer(sweep, vault.funder);
    };

    event::emit(VaultRevoked {
        vault_id: object::id(vault),
        funder: vault.funder,
        returned,
    });
}

/// Kill one capsule without tearing down the vault behind it. For when a
/// vault backs several capabilities and only one should end.
public fun revoke_capsule(capsule: &mut Capsule, clock: &Clock, ctx: &TxContext) {
    assert!(capsule.issuer == ctx.sender(), E_NOT_ISSUER);
    assert!(!capsule.revoked, E_REVOKED);

    capsule.revoked = true;

    event::emit(CapsuleRevoked {
        capsule_id: object::id(capsule),
        by: ctx.sender(),
        spent: capsule.spent,
        at_ms: clock.timestamp_ms(),
    });
}

/// Issuer's pause switch.
public fun set_issuer_pause(capsule: &mut Capsule, paused: bool, clock: &Clock, ctx: &TxContext) {
    assert!(capsule.issuer == ctx.sender(), E_NOT_ISSUER);
    capsule.issuer_paused = paused;
    emit_pause(capsule, clock, ctx.sender());
}

/// The principal's own pause switch, independent of the issuer's. Execution
/// resumes only when both are clear.
public fun set_principal_pause(capsule: &mut Capsule, paused: bool, clock: &Clock, ctx: &TxContext) {
    assert!(capsule.principal.is_some(), E_NOT_CLAIMED);
    assert!(*capsule.principal.borrow() == ctx.sender(), E_NOT_PRINCIPAL);
    capsule.principal_paused = paused;
    emit_pause(capsule, clock, ctx.sender());
}

fun emit_pause(capsule: &Capsule, clock: &Clock, by: address) {
    event::emit(PauseChanged {
        capsule_id: object::id(capsule),
        issuer_paused: capsule.issuer_paused,
        principal_paused: capsule.principal_paused,
        by,
        at_ms: clock.timestamp_ms(),
    });
}

/// Hand the capability back. Principal only, irreversible.
///
/// Funds stay in the vault, which was always the issuer's — they withdraw
/// separately. What surrender gives the principal is release from the
/// liability of holding a live standing authority.
public fun surrender(capsule: &mut Capsule, clock: &Clock, ctx: &TxContext) {
    assert!(capsule.principal.is_some(), E_NOT_CLAIMED);
    assert!(*capsule.principal.borrow() == ctx.sender(), E_NOT_PRINCIPAL);
    assert!(!capsule.surrendered, E_SURRENDERED);

    capsule.surrendered = true;

    event::emit(Surrendered {
        capsule_id: object::id(capsule),
        by: ctx.sender(),
        spent: capsule.spent,
        at_ms: clock.timestamp_ms(),
    });
}

/// Tighten the bounds. Callable by either the issuer or the principal,
/// because shrinking a capability is always safe. Each value must be at or
/// below the current one — this function cannot widen anything.
///
/// There is deliberately no counterpart that raises a cap from here. Growing
/// a capability means minting a new capsule, so the terms are re-stated and
/// re-agreed rather than quietly edited.
public fun reduce_caps(
    capsule: &mut Capsule,
    new_per_action_cap: u64,
    new_per_window_cap: u64,
    new_total_cap: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    let is_issuer = capsule.issuer == sender;
    let is_principal =
        capsule.principal.is_some() && *capsule.principal.borrow() == sender;
    assert!(is_issuer || is_principal, E_NOT_PRINCIPAL);

    assert!(new_per_action_cap <= capsule.per_action_cap, E_BAD_CAPS);
    assert!(new_per_window_cap <= capsule.per_window_cap, E_BAD_CAPS);
    assert!(new_total_cap <= capsule.total_cap, E_BAD_CAPS);

    capsule.per_action_cap = new_per_action_cap;
    capsule.per_window_cap = new_per_window_cap;
    capsule.total_cap = new_total_cap;

    event::emit(CapsReduced {
        capsule_id: object::id(capsule),
        per_action_cap: new_per_action_cap,
        per_window_cap: new_per_window_cap,
        total_cap: new_total_cap,
        by: sender,
        at_ms: clock.timestamp_ms(),
    });
}

// ===== Read accessors =============================================
// The frontend and the agent both reconstruct state from these.

public fun vault_balance<T>(vault: &Vault<T>): u64 { vault.balance.value() }

public fun vault_funder<T>(vault: &Vault<T>): address { vault.funder }

public fun vault_revoked<T>(vault: &Vault<T>): bool { vault.revoked }

public fun capsule_vault_id(c: &Capsule): ID { c.vault_id }

public fun capsule_issuer(c: &Capsule): address { c.issuer }

public fun capsule_principal(c: &Capsule): Option<address> { c.principal }

public fun capsule_holder(c: &Capsule): Option<address> { c.holder }

public fun capsule_is_claimed(c: &Capsule): bool { c.holder.is_some() }

public fun capsule_spent(c: &Capsule): u64 { c.spent }

public fun capsule_window_spent(c: &Capsule): u64 { c.window_spent }

public fun capsule_windows_used(c: &Capsule): u64 { c.windows_used }

public fun capsule_policy_hash(c: &Capsule): vector<u8> { c.policy_hash }

public fun capsule_is_paused(c: &Capsule): bool {
    c.issuer_paused || c.principal_paused
}

/// Remaining spend in the current window, ignoring whether the window has
/// rolled. Callers that need the post-roll figure should consult the chain
/// through a dry-run of `execute`.
public fun capsule_window_remaining(c: &Capsule): u64 {
    if (c.window_spent >= c.per_window_cap) 0
    else c.per_window_cap - c.window_spent
}

// ===== Test-only ==================================================

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}
