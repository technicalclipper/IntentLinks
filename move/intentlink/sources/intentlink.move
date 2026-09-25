/// IntentLink — a link that carries a permission.
///
/// A `Vault` holds the issuer's funds. A `Capsule` is a bounded, revocable
/// permission to spend from that vault. The agent holding a capsule can never
/// exceed its bounds, leave its scope, redirect its proceeds, or act after
/// revocation — not because it behaves, but because these functions abort.
module intentlink::intentlink;

use sui::balance::{Self, Balance};
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
    surrendered: bool,

    // --- cross-chain linkage -------------------------------------
    /// ENS namehash of the subname that publishes this capsule.
    ens_node: vector<u8>,
    /// Hash of the canonical policy JSON. The agent resolves the ENS record
    /// and halts unless it matches this value — ENS and Sui must agree.
    policy_hash: vector<u8>,
}

/// Authority to mint escalation permits. Held by the backend that verifies
/// World ID proofs. Making it an object means the trust boundary is explicit
/// and auditable on-chain rather than implied.
public struct EscalationCap has key, store {
    id: UID,
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

// ===== Init =======================================================

fun init(ctx: &mut TxContext) {
    transfer::transfer(
        EscalationCap { id: object::new(ctx) },
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
