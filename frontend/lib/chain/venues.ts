/**
 * Trading venues the agent may be scoped to.
 *
 * `ExecTicket` is deliberately venue-agnostic — the swap happens between
 * begin_execute and settle, as a PTB command, so the capability layer
 * imports no DEX and adding one is a single command. What follows is why we
 * ship our own pool anyway.
 *
 * DEEPBOOK, CHECKED 2026-09-26
 *
 * DeepBook v3 is live on testnet. Package:
 *   0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982
 *
 * Pools and their order books at the time of checking:
 *
 *   SUI_DBUSDC     bids []                 asks [1.496 × 1]
 *   DEEP_SUI       bids [0.02521 × 91]     asks [0.02569 × 1151]
 *   DEEP_DBUSDC    bids []                 asks [0.01438 × 10]
 *   DBUSDT_DBUSDC  bids [1 × 0.1]          asks []
 *   WAL_SUI        bids [0.01 × 10]        asks []
 *   WAL_DBUSDC     bids [0.01 × 10]        asks []
 *   DBTC_DBUSDC    bids []                 asks []
 *
 * Our demo sells SUI, which means hitting a bid. SUI_DBUSDC has none — the
 * swap would return dust and the demo would break on stage. DEEP_SUI does
 * have depth, but trading against it means selling SUI for DEEP, and a
 * testnet book with one maker can empty between now and judging.
 *
 * A CLOB with no makers is not a liquidity problem we can solve, so we ship
 * a seeded constant-product pool and keep the venue pluggable. That is the
 * honest engineering answer and it is backed by the numbers above.
 */

export interface Venue {
  id: string;
  label: string;
  kind: "amm" | "clob";
  /** Whether the agent may actually route through it today. */
  live: boolean;
  note?: string;
}

export const DEMO_POOL_ID = process.env.NEXT_PUBLIC_DEMO_POOL_ID ?? "";

export const DEEPBOOK_PACKAGE =
  "0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982";

export const DEEPBOOK_POOLS = {
  SUI_DBUSDC: "0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5",
  DEEP_SUI: "0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f",
} as const;

export const VENUES: Venue[] = [
  {
    id: DEMO_POOL_ID,
    label: "IntentLink SUI/DUSD",
    kind: "amm",
    live: true,
  },
  {
    id: DEEPBOOK_POOLS.SUI_DBUSDC,
    label: "DeepBook SUI/DBUSDC",
    kind: "clob",
    live: false,
    note: "no bids on testnet — selling SUI here returns dust",
  },
];

export function liveVenues(): Venue[] {
  return VENUES.filter((v) => v.live && v.id);
}
