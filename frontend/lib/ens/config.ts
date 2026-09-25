/**
 * ENSv2 on Sepolia.
 *
 * STATUS — blocked on a published ABI, see notes at the bottom.
 *
 * What we verified on chain:
 *   - intentlink.eth EXISTS in the v2 ETHRegistry (it has a resolver set)
 *   - it has NO subregistry, so it cannot issue subnames yet
 *   - we do NOT own intentlink.eth on the v1 registry (owner is the zero
 *     address there), so the well-trodden v1 setSubnodeRecord path is not
 *     available without registering a second name
 */

export const SEPOLIA_CHAIN_ID = 11155111;

export const ENS_V2 = {
  ethRegistry: "0x657ea849311d3d5823348dded7c2aaafb3ede09e",
  rootRegistry: "0x9703dbd26dab89504490994138cf2c575251a9ce",
  wrapperRegistryImpl: "0x2741543c3b14640b97bc70a233318032f7e35bac",
  ethRegistrar: "0xabe76f6c8dfced81aa5a2bb8034202a7136b94ca",
  rootBatchRegistrar: "0xcf5d485a531863856ed9d8a10d61707de7f06c21",
  publicResolver: "0xd7e590ad0e92a6ac1d81f4483a9b951d3585a50f",
  universalResolver: "0x5d25c1d6acbb71b7a28aa7899618a3412a8303e3",
  verifiableFactory: "0x9e726eb570beb6bceb495ab8cda7df517d4e841c",
} as const;

/** v1, same address on every chain. We do not own a name here yet. */
export const ENS_V1_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

export const ENS_NAME = process.env.ENS_NAME ?? "intentlink.eth";

/** The only part of IRegistry the docs actually publish. */
export const IRegistryAbi = [
  {
    name: "getSubregistry",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "getResolver",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "getParent",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }, { type: "string" }],
  },
] as const;

/** Text record keys. The `il:` prefix is ours; nobody has to approve it. */
export const RECORD = {
  vault: "il:vault",
  capsule: "il:capsule",
  policy: "il:policy",
  status: "il:status",
  expires: "il:expires",
  parent: "il:parent",
  chain: "il:chain",
} as const;

/*
 * WHAT IS BLOCKING
 *
 * Issuing a subname under intentlink.eth needs three calls whose exact
 * signatures we could not obtain:
 *
 *   1. VerifiableFactory.deploy(...)      -> a PermissionedRegistry for us
 *   2. ETHRegistry.setSubregistry(tokenId, registry)
 *   3. ourRegistry.register(label, owner, ...)
 *
 * The ABI is not on Etherscan v2 (needs an API key), not on Sourcify (404),
 * and the published docs describe the calls without giving parameter lists.
 * Guessing selectors against a beta contract with real gas is not a good use
 * of the remaining hours.
 *
 * FASTEST UNBLOCK: the ENS booth. Ask for the exact call sequence to give an
 * existing v2 name a subregistry so it can issue subnames, plus a link to
 * the deployed ABIs. That is a five-minute conversation on site and it also
 * makes a good booth question — it is the real integration problem, not a
 * pitch.
 *
 * FALLBACK if that fails: register a v1 .eth name on Sepolia and use
 * setSubnodeRecord + setText, which is well documented and stable. Loses the
 * Enhanced Access Control story; keeps name-as-capability, the hierarchical
 * delegation tree, and the cross-chain policy-hash check — which is the part
 * that actually differentiates us anyway.
 */
