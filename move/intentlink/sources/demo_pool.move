/// A minimal constant-product pool, so the swap in our demo is a real
/// on-chain trade rather than a mock.
///
/// This is not trying to be a DEX. It exists because the interesting claim
/// is about the *capability* — that funds can leave a vault, pass through an
/// arbitrary venue, and be structurally forced to land on the right address
/// — and demonstrating that needs something real on the other side of
/// `begin_execute`.
///
/// Because `ExecTicket` is DEX-agnostic, swapping this out for Cetus or
/// DeepBook is a change to one PTB command and nothing in the capability
/// layer moves.
module intentlink::demo_pool;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;

const E_ZERO_INPUT: u64 = 1;
const E_EMPTY_POOL: u64 = 2;
const E_NOT_ADMIN: u64 = 3;

/// 0.30%, the usual.
const FEE_BPS: u64 = 30;
const BPS: u64 = 10_000;

public struct Pool<phantom A, phantom B> has key {
    id: UID,
    admin: address,
    reserve_a: Balance<A>,
    reserve_b: Balance<B>,
}

public struct PoolCreated has copy, drop {
    pool_id: ID,
    admin: address,
}

public struct SwapExecuted has copy, drop {
    pool_id: ID,
    amount_in: u64,
    amount_out: u64,
    a_to_b: bool,
}

#[allow(lint(share_owned))]
public fun create_pool<A, B>(a: Coin<A>, b: Coin<B>, ctx: &mut TxContext): ID {
    let pool = Pool<A, B> {
        id: object::new(ctx),
        admin: ctx.sender(),
        reserve_a: a.into_balance(),
        reserve_b: b.into_balance(),
    };
    let pool_id = object::id(&pool);
    event::emit(PoolCreated { pool_id, admin: ctx.sender() });
    transfer::share_object(pool);
    pool_id
}

public fun add_liquidity<A, B>(pool: &mut Pool<A, B>, a: Coin<A>, b: Coin<B>, ctx: &TxContext) {
    assert!(pool.admin == ctx.sender(), E_NOT_ADMIN);
    pool.reserve_a.join(a.into_balance());
    pool.reserve_b.join(b.into_balance());
}

/// x * y = k, minus the fee.
fun quote(reserve_in: u64, reserve_out: u64, amount_in: u64): u64 {
    let after_fee = (amount_in as u128) * ((BPS - FEE_BPS) as u128);
    let numerator = after_fee * (reserve_out as u128);
    let denominator = (reserve_in as u128) * (BPS as u128) + after_fee;
    ((numerator / denominator) as u64)
}

public fun swap_a_for_b<A, B>(
    pool: &mut Pool<A, B>,
    input: Coin<A>,
    ctx: &mut TxContext,
): Coin<B> {
    let amount_in = input.value();
    assert!(amount_in > 0, E_ZERO_INPUT);

    let reserve_in = pool.reserve_a.value();
    let reserve_out = pool.reserve_b.value();
    assert!(reserve_in > 0 && reserve_out > 0, E_EMPTY_POOL);

    let amount_out = quote(reserve_in, reserve_out, amount_in);
    pool.reserve_a.join(input.into_balance());

    event::emit(SwapExecuted {
        pool_id: object::id(pool),
        amount_in,
        amount_out,
        a_to_b: true,
    });

    coin::take(&mut pool.reserve_b, amount_out, ctx)
}

public fun swap_b_for_a<A, B>(
    pool: &mut Pool<A, B>,
    input: Coin<B>,
    ctx: &mut TxContext,
): Coin<A> {
    let amount_in = input.value();
    assert!(amount_in > 0, E_ZERO_INPUT);

    let reserve_in = pool.reserve_b.value();
    let reserve_out = pool.reserve_a.value();
    assert!(reserve_in > 0 && reserve_out > 0, E_EMPTY_POOL);

    let amount_out = quote(reserve_in, reserve_out, amount_in);
    pool.reserve_b.join(input.into_balance());

    event::emit(SwapExecuted {
        pool_id: object::id(pool),
        amount_in,
        amount_out,
        a_to_b: false,
    });

    coin::take(&mut pool.reserve_a, amount_out, ctx)
}

/// What a swap would return, for the agent to pick a `min_out`.
public fun quote_a_for_b<A, B>(pool: &Pool<A, B>, amount_in: u64): u64 {
    quote(pool.reserve_a.value(), pool.reserve_b.value(), amount_in)
}

public fun reserves<A, B>(pool: &Pool<A, B>): (u64, u64) {
    (pool.reserve_a.value(), pool.reserve_b.value())
}
