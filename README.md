# Sequence Token Directory

Token directory that contains a comprehensive list of ERC-20, ERC-721, ERC-1155 and other contracts.

**NOTES:**

- The [./index/index.json](./index/index.json) is an auto-generated file that is a master index of all ./index/\*_/_ contents
  including chain names, chain ids, file names, and sha256 hashes of the file contents. This file
  is perfect for using as the primary index of this repo, and when syncing contents you can traverse this
  index file and also compare the sha256 hash if the file has changed.
- The [./index/deprecated.json](./index/deprecated.json) is a manually maintained file which lists all folders which are deprecated
  and as a result the files will be labelled as deprecated in the master index.json.
- The [./index/external.json](./index/external.json) is a manually maintained file of external token list sources which are synced
  and downloaded to the [./index/\_external](./index/_external) folder. We store the contents here to ensure data integrity,
  and we also compute and include these files in the master index.json.

**REMINDERS:**

- `pnpm reindex` is automatically called as a pre-commit hook anytime an entry it changed. You may also
  call it manually if you like.
- `pnpm sync-external` must be called manually periodically to ensure we have the latest contents, this
  script is not run automatically.
- `pnpm update-featured` updates the `featured` / `featureIndex` fields on ERC-20 tokens based on
  24hr trading volume from the CoinGecko API. See usage below.

## Setup

- `pnpm install` will setup your local tools
- `pnpm reindex` to reindex the token directory master index.json, but see notes above, as this
  is also automatically called as a pre-commit hook.
- `pnpm sync-external` to sync ./index/external.json files to local ./index/\_external/ folder.
- `pnpm update-featured` to update featured token rankings (see below).

## Update Featured Tokens

Ranks tokens by 24hr trading volume from CoinGecko and assigns `featureIndex` values in each chain's `erc20.json`.

Requires a [CoinGecko Pro API key](https://www.coingecko.com/en/api). Copy `.env.sample` to `.env` and fill in your key, or pass it directly:

```bash
COINGECKO_API_KEY=xxx pnpm update-featured
```

By default the script performs a **dry run** — it prints the proposed ranking without writing any files. Pass `--write` to apply changes.

```bash
# Preview changes for all supported chains
pnpm update-featured

# Preview a single chain
pnpm update-featured -- --chain arbitrum

# Apply changes
pnpm update-featured -- --write

# Feature top 20 instead of default 50
pnpm update-featured -- --write --count 20
```

Supported chains: mainnet, arbitrum, polygon, optimism, base, avalanche, bnb, gnosis, arbitrum-nova.

## Sync Fee-on-Transfer Tokens

Flags tokens that tax transfers with `extensions.feeOnTransfer: true`, so consumers can refuse to
quote a fixed amount the recipient will never receive in full.

Detection uses the [GoPlus token security API](https://gopluslabs.io/token-security-api): any
token with a non-zero `transfer_tax` is flagged. An empty `transfer_tax` means GoPlus has no
result for the token, which is counted as unknown rather than treated as zero. GoPlus only computes
fresh reports for single-address requests, so tokens are queried one at a time with a 4s delay and
rate-limit responses are retried with backoff — a full scan takes hours. Results are cached in
`tools/.fee-on-transfer-cache.json` so an interrupted scan resumes.

By default the script performs a **dry run**. Pass `--write` to apply changes.

```bash
# Preview all supported chains
pnpm sync-fee-on-transfer

# Preview a single chain
pnpm sync-fee-on-transfer -- --chain bnb

# Apply changes
pnpm sync-fee-on-transfer -- --write
```

Supported chains (those GoPlus covers): mainnet, polygon, base, optimism, arbitrum, avalanche, bnb,
gnosis, berachain, soneium, sonic, monad.

Run `pnpm format` afterwards: the script writes with `JSON.stringify`, which expands short
arrays that Prettier keeps inline.

## Sync Rebasing Tokens

Flags tokens whose balances change without a transfer — Aave aTokens, Lido stETH, Ampleforth,
Origin OUSD/OETH — with `extensions.rebasing: true`, so consumers can refuse to quote a fixed
amount against a balance that moves underneath them.

Detection is on-chain and evidence-based: each token is probed over public RPCs for read-only
selector pairs that only a rebasing implementation exposes (`UNDERLYING_ASSET_ADDRESS` +
`scaledBalanceOf` for Aave v2/v3, `underlyingAssetAddress` + `principalBalanceOf` for Aave v1,
`getPooledEthByShares` + `sharesOf` for stETH, `rebasingCreditsPerToken` + `nonRebasingSupply`
for Origin). ERC-4626 vaults are excluded deliberately: `sUSDe` and `wstETH` move share
_price_, not balances, so fixed-amount math against them stays correct.

Every probe carries a `totalSupply` sentinel. If the sentinel fails the result is discarded and
retried in smaller batches, then as individual `eth_call`s — a missing selector and an RPC that
silently dropped the call are otherwise indistinguishable, and the latter would unflag real
rebasing tokens. Tokens that never answer are reported as `unreachable` rather than assumed
clean. Results are cached in `tools/.rebasing-cache.json` so an interrupted scan resumes.

By default the script performs a **dry run**. Pass `--write` to apply changes.

```bash
# Preview all supported chains
pnpm sync-rebasing

# Preview a single chain
pnpm sync-rebasing -- --chain base

# Apply changes
pnpm sync-rebasing -- --write
```

Run `pnpm format` afterwards: the script writes with `JSON.stringify`, which expands short
arrays that Prettier keeps inline.

## Token List Formats

The ERC-20 token lists present in this repository follow the [Uniswap Token List Schema](https://github.com/Uniswap/token-lists). The original list was populated using [Coingecko](https://www.coingecko.com/en)'s erc20 token list [CoinGecko](https://tokens.coingecko.com/uniswap/all.json). Token description and links are taken from Coingecko's API.

The ERC-721 and ERC-1155 token lists present in this repository follow the [Sequence Collectible List Schema](https://github.com/0xsequence/collectible-lists).

## How to Add or Update Your Token / Contract

If a token is missing entirely, or contains incorrect or missing information, please stick to the following procedure;

1. Fork this repository
2. git clone, then: `pnpm install` to setup local tools
3. Add your entry directly inside of `./index/<chain>/<standard>.json`
4. [Open a PR](https://github.com/0xsequence/token-directory/compare) comparing the master branch with your fork
5. In the PR, add an explanation if this PR is for an existing token that needs to be updated

## Formats

Depending on the standard, your token entries should respect the following format:

### ERC20

See [here](https://github.com/0xsequence/token-directory/blob/master/index/mainnet/erc20.json) for examples.

```typescript
{
  chainId: number,         // Chain ID
  address: string,         // Contract address
  name: string,            // Name of token, 40 chars max
  symbol: string,          // Symbol of token, 20 chars max
  decimals: number,        // Number of decimals token uses
  logoURI: string | null,  // URI / URL for token logo
  extensions: {
    link: string | null,        // URL of token's website
    description: string | null, // Short description of token (1000 chars max)
    ogImage: string | null,     // URL of Open Graph image of token website
    feeOnTransfer?: true,       // Set when the token taxes transfers; omitted otherwise
    rebasing?: true             // Set when balances change without a transfer
                                // (Aave aTokens, stETH, AMPL); omitted otherwise
}
```

`feeOnTransfer` and `rebasing` are populated by tooling rather than by hand — see
[Sync Fee-on-Transfer Tokens](#sync-fee-on-transfer-tokens) and
[Sync Rebasing Tokens](#sync-rebasing-tokens). Both are present only when true, so absence
means "no evidence gathered", not "verified false".

### ERC721 and ERC1155

See [here](https://github.com/0xsequence/token-directory/blob/master/index/mainnet/erc721.json) for erc721 and [here](https://github.com/0xsequence/token-directory/blob/master/index/mainnet/erc1155.json) for erc1155 examples.

```typescript
{
  chainId: number,                // Chain ID
  address: string,                // Contract address
  name: string,                   // Name of token, 40 chars max
  standard: 'erc721' | 'erc1155', // Name of token's standard
  symbol: string | null,          // Symbol of token, 20 chars max
  logoURI: string | null,         // URI / URL for token logo
  extensions: {
    link: string | null,        // URL of token's website
    description: string | null, // Short description of token (1000 chars max)
    ogImage: string | null      // URL of Open Graph image of token website
}
```

## LICENSE

MIT
