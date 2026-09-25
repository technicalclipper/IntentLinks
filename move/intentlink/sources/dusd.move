/// The demo quote asset.
///
/// A real trade needs two assets. This is the second one — it has no issuer
/// of consequence and exists only so the pool has something to swap against
/// on testnet.
module intentlink::dusd;

use sui::coin::{Self, Coin, TreasuryCap};

public struct DUSD has drop {}

fun init(witness: DUSD, ctx: &mut TxContext) {
    let (treasury, metadata) = coin::create_currency(
        witness,
        9,
        b"DUSD",
        b"IntentLink Demo USD",
        b"Testnet-only quote asset for IntentLink demos",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    transfer::public_transfer(treasury, ctx.sender());
}

public fun mint(cap: &mut TreasuryCap<DUSD>, amount: u64, ctx: &mut TxContext): Coin<DUSD> {
    coin::mint(cap, amount, ctx)
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(DUSD {}, ctx)
}
