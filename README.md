Sequence Token Directory
========================

Token directory that contains a comprehensive list of ERC-20, ERC-721, ERC-1155 and other contracts.

**NOTES:**
* The [./index/index.json](./index/index.json) is an auto-generated file that is a master index of all ./index/**/* contents
including chain names, chain ids, file names, and sha256 hashes of the file contents. This file
is perfect for using as the primary index of this repo, and when syncing contents you can traverse this
index file and also compare the sha256 hash if the file has changed.
* The [./index/deprecated.json](./index/deprecated.json) is a manually maintained file which lists all folders which are deprecated
and as a result the files will be labelled as deprecated in the master index.json.
* The [./index/external.json](./index/external.json) is a manually maintained file of external token list sources which are synced
and downloaded to the [./index/_external](./index/_external) folder. We store the contents here to ensure data integrity,
and we also compute and include these files in the master index.json.

**REMINDERS:**
* `pnpm reindex` is automatically called as a pre-commit hook anytime an entry it changed. You may also
call it manually if you like.
* `pnpm sync-external` must be called manually periodically to ensure we have the latest contents, this
script is not run automatically.


## Setup 

* `pnpm install` will setup your local tools
* `pnpm reindex` to reindex the token directory master index.json, but see notes above, as this
is also automatically called as a pre-commit hook.
* `pnpm sync-external` to sync ./index/external.json files to local ./index/_external/ folder.

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
    ogImage: string | null      // URL of Open Graph image of token website 
}
```

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
