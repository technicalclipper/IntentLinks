/**
 * ENSv2 ABIs, recovered from deployed bytecode.
 *
 * The signatures are not published anywhere reachable — Sourcify 404s on
 * these contracts and Etherscan v2 requires an API key. They were recovered
 * by walking the proxy chain (EIP-1167 clone → ERC-1967 slot → implementation)
 * and matching PUSH4 selectors in the dispatch table against candidate
 * signatures.
 *
 * Verified present on 0xa80338aaa8d23831cea25e858d1774534abb0263, the
 * PermissionedRegistry implementation behind our subregistry.
 */

export const PermissionedRegistryAbi = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "label", type: "string" },
      { name: "owner", type: "address" },
      { name: "subregistry", type: "address" },
      { name: "resolver", type: "address" },
      { name: "roleBitmap", type: "uint256" },
      { name: "expires", type: "uint64" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    name: "setResolver",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "resolver", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "setSubregistry",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "registry", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "grantRoles",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "roles", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "revokeRoles",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "roles", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "hasRoles",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "roles", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
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
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "latestOwnerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "getExpiry",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "uint64" }],
  },
] as const;

/**
 * The resolver that ships on a v2 .eth name.
 *
 * Not the classic namehash interface. Writes take a **DNS-encoded name**
 * (`\x03dca\x0aintentlink\x03eth\x00`), and reads go through ENSIP-10
 * `resolve(name, data)` with an inner `text(bytes32,string)` call.
 *
 * PublicResolverV2 does expose the familiar `setText(bytes32,…)`, but it
 * reverts for our names — it cannot authorise us for a subname under a
 * registry it does not know about. The parent's own resolver authorises the
 * whole subtree, so that is the one to use.
 */
export const SubtreeResolverAbi = [
  {
    name: "setText",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "bytes" },
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
    outputs: [],
  },
  {
    name: "resolve",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "name", type: "bytes" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ type: "bytes" }],
  },
  {
    name: "multicall",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ type: "bytes[]" }],
  },
] as const;

/** Inner call encoded into `resolve`, per ENSIP-10. */
export const TextAbi = [
  {
    name: "text",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
    ],
    outputs: [{ type: "string" }],
  },
] as const;

/**
 * Enhanced Access Control roles.
 *
 * Roles are scoped per name, and each role at bit N has an admin at N + 128
 * controlling who may grant or revoke it. Only the name owner can hold admin
 * roles, so permissions cannot survive a transfer.
 *
 * Only ROLE_SET_RESOLVER (bit 24) is documented. Probing a freshly
 * registered name showed the rest sit at every fourth bit — 0, 4, 8, 12, 16,
 * 20, 24, 28 — with the owner holding the full base and admin set after
 * register(), whatever bitmap was passed in.
 */
export const ROLE_BIT_SPACING = 4n;
export const ROLE_SET_RESOLVER = 1n << 24n;
export const ROLE_SET_RESOLVER_ADMIN = 1n << (24n + 128n);

/** What we grant ourselves on each capsule subname: set records, and delegate that. */
export const CAPSULE_ROLES = ROLE_SET_RESOLVER | ROLE_SET_RESOLVER_ADMIN;

/** ERC-1155 mint event, the only way to learn a name's tokenId. */
export const TransferSingleAbi = [
  {
    type: "event",
    name: "TransferSingle",
    inputs: [
      { indexed: true, name: "operator", type: "address" },
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "id", type: "uint256" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
] as const;
