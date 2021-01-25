# Sequence Token Directory
Token directory that contains a list of almost all ERC-20, ERC-721 and ERC-1155 tokens.

## Token List Formats
The ERC-20 token lists present in this repository follow the [Uniswap Token List Schema](https://github.com/Uniswap/token-lists). The original list was populated using [Coingecko](https://www.coingecko.com/en)'s erc20 token list [CoinGecko@95.1.0](https://tokens.coingecko.com/uniswap/all.json). Token description and links are taken from Coingecko's API.

The ERC-721 and ERC-1155 token lists present in this repository follow the [Sequence Collectible List Schema](https://github.com/0xsequence/collectible-lists). The original list was populated using [Dune Analytics](https://www.duneanalytics.com/) via the query [#16838](https://explore.duneanalytics.com/queries/16838). Token description and links were taken from [OpenSea](https://opensea.io/)'s API.

## Add or Update Your Token
If a token is missing entirely, or contains incorrect or missing information, please stick to the following procedure;

1. Fork the current Token Directory repository
2. Add your token in the `tokens` array in the correct file in the [src/registry/]() folder
   e.g. 
3. [Open a PR](https://github.com/0xsequence/token-directory/compare) comparing the main branch with your fork
4. In the PR, add an explanation if this PR is for an existing token that needs to be updated

If the token is already part of the list, the token

## Formats
Depending on the standard, your token entries should respect the following format:

### ERC20
See [here]() for examples.

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
See [here]() for examples.

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