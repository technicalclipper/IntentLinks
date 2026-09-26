<div align="center">

# ⇥ IntentLink

**Shareable links that grant AI agents bounded, revocable spending authority — enforced on-chain.**

[**Live app**](https://intentlink.vercel.app) · [**Pitch deck**](https://intentlink.vercel.app/deck) · Sui · ENS · World ID

</div>

---

## The idea

You write what an agent may do in plain English. You send a link. Whoever opens it proves
they're a human and plugs in whatever agent they like.

The limits aren't in our code. They're Move asserts on Sui — **nineteen of them, on every
single spend.**

```
"Sell 0.02 SUI a day for 30 days, max 1% slippage, send the DUSD to bob@gmail.com"
                              ↓
        a Capsule on Sui  +  a subname on ENS  +  a link with a QR
```

## What it's for

Handing an agent money today means handing over the keys and hoping. You get a valet who can
drive anywhere, and a note on the dashboard asking nicely.

IntentLink is the valet key. The car starts, the boot stays shut — and it isn't a promise,
it's the shape of the key.

| | |
|---|---|
| **Set it up for Mum** | She gets a link, not a wallet. Google sign-in, an agent manages her savings, she can hand it back any time. She never sees a seed phrase. |
| **A strategy you don't babysit** | 30 days, a daily budget, one pool. It trades while you sleep, inside limits you set once, while awake. |
| **Any agent platform** | Bring the permission to the agent, instead of the agent to the money. |
| **Allowances, payroll, subscriptions** | Anywhere one party funds and another spends — with a ceiling, a clock, and a revoke button. |

The primitive is **delegated, bounded, revocable authority**. Trading is just the demo.

---

# How each sponsor technology is used

## 🟦 Sui — it enforces the permission

Everything that matters is a Move object, and the guarantees are asserts rather than
promises about our server.

### Four objects

| Object | What it is |
|---|---|
| **`Vault<T>`** | Holds the money. Shared. The agent never owns it, and never owns the coins inside. |
| **`Capsule`** | The permission. `key` only, **no `store`** — it cannot be transferred, sold or wrapped. Access is by field, not ownership. |
| **`Permit`** | One-shot authority to exceed a soft cap. No `store`, no `copy`, **no `drop`**. `execute_elevated` takes it *by value* and destroys it, so replay isn't defended against — it's unrepresentable. |
| **`ExecTicket`** | A hot potato with **no abilities at all**. Cannot be stored, copied, or discarded. |

Access on a Capsule is by field, so three parties share one object without sharing power:

| Field | Who | May |
|---|---|---|
| `issuer` | the sender | revoke · pause · top up · tighten |
| `principal` | the recipient | pause · hand back |
| `holder` | the agent's key | **execute — and nothing else** |

### The hot potato

```move
begin_execute(...)          // hands out the coin AND the ticket
   <swap at any venue>      // we import no DEX — this is an ordinary Move call
settle(ticket, proceeds)    // checks the destination, destroys the ticket
```

`ExecTicket` has no abilities, and only `settle` can destroy one. A transaction holding it is
**structurally incapable of finishing** unless the proceeds land on the beneficiary fixed at
mint. The agent isn't trusted not to skim — a transaction where it skims *cannot be built*.

Because the swap is just a call between those two, any venue works and we're coupled to none.

### The nineteen asserts

Every spend goes through `check_and_charge`:

| Group | # | Checks |
|---|---|---|
| Who is asking | 3 | vault matches the capsule · it's been claimed · `holder == ctx.sender()` |
| Is it alive | 6 | vault not revoked · capsule not revoked · not surrendered · not paused by *either* party · past `not_before` · before `expires_at` |
| Recurrence | 1 | windows not exhausted |
| **Soft caps** | 3 | amount > 0 · per-action cap · per-window cap |
| **Hard caps** | 2 | hard cap · total cap |
| Scope | 3 | pool in `allowed_pools` *by object ID* · slippage bound · **recipient == the beneficiary** |
| Funds | 1 | the vault has the balance |

Plus one in `settle` (the fill must beat the floor the agent committed to) and three more on
the permit path.

**An approved escalation lifts the soft caps and only those.** Nothing lifts the hard cap —
not a permit, not the issuer at 3am, not a compromised backend. That ceiling is set once, at
mint, by someone thinking clearly.

### Also on Sui

- **zkLogin + sponsored transactions**, built ourselves rather than with a managed service:
  our own salt derivation, prover client, and a gas station with a reserved coin pool. Users
  sign in with Google and pay no gas — no wallet, no seed phrase.
- **43 Move tests**, one per assert, including the ones that only fail at a genesis-epoch
  clock.
- A **generic `Vault<T>` and `settle<O>`**, so the asset pair is a type parameter.

```
package (types)   0x2df6677d2f70da05de61b1be4b90ed455c0364e647a03f326638ffbd55867c87
package (latest)  0x095f3b27c644319d9fc0177f0b9b398f0dd81a1e7961082645075825ca61cba0
VerifierCap       0xa07750dcda89aa2ae50bcc3c1a782d87d5dcf8b06771ef6e0338201270267168
demo pool         0x426b26baf8452e4f48f619023a4ec87a54e8a655df5e289266ca8f32cc4f03be
```

---

## 🟩 ENS — it publishes the permission

Most projects use ENS as a prettier address. Here the name **is** the published contract, and
it is load-bearing: the agent halts if the name disagrees with the chain.

Every capability is a subname under **`intentlink.eth`**, registered programmatically through
an **ENSv2 `PermissionedRegistry`** — thousands of names, not one vanity registration.

### What a name carries

```
cap-07afa071.intentlink.eth
  description   Buy SUI daily · up to 0.02 SUI/day · 30 periods · revocable
  il:capsule    0x07afa071…     the Sui object being governed
  il:vault      0xc0128c4b…     where the money is
  il:chain      sui:testnet
  il:policy     0xd185a19e…     ← hash of the terms
  il:status     active
  il:expires    1792953215512
```

`description` is deliberately the **standard** key, so a capability renders in any ENS-aware
tool rather than only in ours. The `il:` prefix namespaces the rest.

### The cross-chain check

The policy is canonicalised (keys deep-sorted, so the hash is a function of content and not
of whichever serialiser ran) and hashed. That hash goes to **both chains in the same flow** —
into `il:policy` on Ethereum, and into `capsule.policy_hash` on Sui.

Three comparisons, answering different questions:

1. **Hash vs hash** — do Ethereum and Sui agree with each other?
2. **Document vs object** — our stored policy, field by field, against the capsule's real
   numbers: all nine bounds, the pool list, and the beneficiary. *Is our own server telling
   the truth about the chain?*
3. **The agent gate** — before every action the agent resolves ENS and halts on a
   contradiction.

A recipient sees **⛓ Verified** only when 1 and 2 both pass. Live right now:

```
ENS  il:policy   : 0xd185a19e862560974e5558a235a72dff1e641172819350433c383b81a7cdb862
Sui  policy_hash : 0xd185a19e862560974e5558a235a72dff1e641172819350433c383b81a7cdb862
```

### ENSv2 specifics

- Names are **ERC-1155**; the `tokenId` surfaces only in the `TransferSingle` mint event, so
  it's parsed from the receipt to manage roles later.
- Records written through a **subtree resolver** with `setText(dnsName, key, value)`, batched
  in a **multicall** so a name is never half-updated — a capability whose `status` said
  *active* while its `policy` said something else would be worse than no record at all.
- Read back with **ENSIP-10 `resolve()`**.
- **Enhanced Access Control**: we grant exactly `ROLE_SET_RESOLVER | ROLE_SET_RESOLVER_ADMIN`
  per name — set records and delegate that, nothing more. Only bit 24 is documented, so the
  layout was recovered by probing a freshly registered name: roles sit at every fourth bit,
  admin at `+128`.

```
name          intentlink.eth            (Sepolia)
subregistry   0xE6A68C12401eA9D29d8465f78eAd7Fb7c6E1Dee1
resolver      0xB9DD72FFC2a75Ed1bcEE1716e04d6912B1B35aD4
```

---

## ⬛ World ID — it vouches for the human

Two moments, and they are not equally interesting.

### At redemption

A **live human** is claiming this — not a script, not a credential stored earlier and
replayed. (Single-claim is enforced separately and independently by
`assert!(capsule.holder.is_none())` on Sui.)

### At escalation — the one nothing else can do

An agent can **ask** to exceed its limit. It can never approve.

```move
public fun approve_escalation(...) {
    assert!(ctx.sender() == capsule.issuer, E_NOT_ISSUER);
    ...
}
```

Three things must be true before a `Permit` exists, and no two substitute for each other:

1. **The contract** — the sender is the capsule's issuer. Sameness of account, settled on
   chain by a key the agent has never held.
2. **World ID** — a fresh proof that a human is present *now*, with the signal bound to
   `hash(capsule, amount, nonce)`, so a stored credential can't be replayed and a yes to 26
   can't be stretched into a yes to 260.
3. **The nullifier** — proving under the World **session** recorded at mint yields a
   nullifier directly comparable to the capsule's, so the check is *the same human*, not just
   the same account.

> Every other approval mechanism is a bearer credential — and a bearer credential can be
> handed to the very agent you are trying to constrain. A live human cannot.

Built on **World ID v4**: protocol-level RP-signed requests, credential presets, and sessions
for stable cross-verification nullifiers.

```
app    app_8ba25bd6140ee2048bad53e86d7326ff
rp     rp_c99f7ac13ef55e6f
```

---

# Bring your own agent

`claim()` always took an arbitrary address for `holder` — nothing in the contract said it had
to be ours. So a capability can be handed to an agent we did not write and have never seen,
and every guarantee holds unchanged.

**Every permission is also an MCP server.** One line of config into Claude Desktop, Cursor,
or anything that speaks MCP:

```json
{ "mcpServers": { "intentlink": { "type": "http", "url": "https://intentlink.vercel.app/api/mcp/ilk_…" } } }
```

That assistant now has five tools, generated from the capsule with live figures:

`get_permission` · `quote` · `execute` · `request_escalation` · `get_history`

Two layers, deliberately independent:

- The **tool list** is built from the capsule, so an agent can't see an out-of-scope action.
  That's ergonomics, and it's soft.
- **`execute` meets the same nineteen asserts.** An agent that ignores every description and
  asks for ten times the cap gets an abort code and moves no coin. That's the guarantee, and
  it doesn't depend on the agent having read anything.

Verified on testnet — a delegated key holding **zero SUI** (gas is sponsored):

```
execute 0.01 SUI  →  executed, settled to the beneficiary
execute 5.00 SUI  →  refused_by: "the Sui contract"
                     abort: E_OVER_ACTION_CAP
                     nothing_moved: true
```

---

# The full flow

**Create** · Type it in English. An LLM compiles it to a policy and splits every clause into
*enforced / advisory / refused*, shown **before** anything is minted. Verify with World. Two
Sui transactions fund the vault and mint the capsule; the ENS subname is registered with the
policy hash. You get a link and a QR.

**Redeem** · They open the link and see Granted / Not granted plus the verification badge.
Google sign-in — no wallet, no gas. Verify with World. Then they **choose who acts**: our
managed agent, their own AI over MCP, or their own key. That choice sets `holder`, once.

**Run** · Three ways, identical asserts — the managed agent with a live console, the
**keeper** on a schedule with nobody watching, or their own AI over MCP.

**Escalate** · Agent asks on chain → issuer sees a card → verifies with World → signs with
*their* key → a one-shot `Permit`, still under the hard cap.

**End it** · Issuer: pause, revoke, or revoke-and-sweep atomically. Recipient: pause, or hand
back — not "revoke", because the funds were never theirs to reclaim.

**Audit** · History is rebuilt from **Move events**, identical for both parties. Not a log our
server writes — the thing that actually happened.

### Where the money goes

Proceeds land in the recipient's own wallet **in the same transaction as the trade**. Not
pooled, not held by us, not held by the agent. Three modes, fixed at mint: back to the
**vault**, to the **principal**, or to a **fixed** address.

---

# Running it

```bash
# Move
cd move/intentlink && sui move test          # 43 tests

# Frontend
cd frontend && npm install && npm run dev    # needs .env.local

# The keeper — recurrence with nobody watching
npx tsx --env-file=.env.local scripts/keeper.ts 60
```

```
move/intentlink/sources/intentlink.move   the capability layer
move/intentlink/sources/demo_pool.move    a constant-product AMM, so the demo is a real trade
frontend/lib/chain/                       client, tx builders, reads, events, gas station
frontend/lib/agent/                       the runtime, and bring-your-own-agent
frontend/app/api/mcp/[token]/             a capability, as an MCP server
frontend/app/deck/                        the pitch
```

---

<div align="center">

**Anyone can build an agent that spends money. We built the part that says no.**

Built at ETHGlobal Tokyo 2026

</div>
