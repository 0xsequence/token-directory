import * as fs from "fs"
import { TokenInfo, TokenList, nextVersion, VersionUpgrade } from "@uniswap/token-lists"
import { CollectibleInfo, CollectibleList } from "@0xsequence/collectible-lists"
import fetch from "node-fetch"

const ERC20_LIST_PATH   = "../index/matic/erc20.json"
const ERC721_LIST_PATH  = "../index/matic/erc721.json"
const ERC1155_LIST_PATH = "../index/matic/erc1155.json"

// Load mainnet lists
const erc20_mainnet: TokenList         = require("../../index/mainnet/erc20.json")
const erc721_mainnet: CollectibleList  = require("../../index/mainnet/erc721.json")
const erc1155_mainnet: CollectibleList = require("../../index/mainnet/erc1155.json")

// Matic lists
const erc20_matic: TokenList         = require("../../index/matic/erc20.json")
const erc721_matic: CollectibleList  = require("../../index/matic/erc721.json")
const erc1155_matic: CollectibleList = require("../../index/matic/erc1155.json")

// Only get token addresses
const erc20_addresses_mainnet   = erc20_mainnet.tokens.map(t => t.address.toLocaleLowerCase())
const erc721_addresses_mainnet  = erc721_mainnet.tokens.map(t => t.address.toLocaleLowerCase())
const erc1155_addresses_mainnet = erc1155_mainnet.tokens.map(t => t.address.toLocaleLowerCase())
const erc20_addresses_matic     = erc20_matic.tokens.map(t => t.address.toLocaleLowerCase())
const erc721_addresses_matic    = erc721_matic.tokens.map(t => t.address.toLocaleLowerCase())
const erc1155_addresses_matic   = erc1155_matic.tokens.map(t => t.address.toLocaleLowerCase())

// New Matic tokens
const erc20_matic_new: TokenInfo[] = []
const erc721_matic_new: CollectibleInfo[] = []
const erc1155_matic_new: CollectibleInfo[] = []

const main = async () => {

  // Fetch all tokenMapping events
  const resp = await fetch("https://api.thegraph.com/subgraphs/name/maticnetwork/mainnet-root-subgraphs", {
    "body": "{\"query\":\"{\\n  tokenMappings(first:1000) {rootToken childToken}}\",\"variables\":null}",
    "method": "POST"
  });
  const mappings = (await resp.json()).data.tokenMappings
  
  // Build list of all missings tokens
  for (const i in mappings) {
    const root  = mappings[i].rootToken
    const child = mappings[i].childToken

    // Is ERC-20, ERC-721 or ERC-1155
    if (erc20_addresses_mainnet.includes(root)) {
      if (!erc20_addresses_matic.includes(child)) {
        const origin_token = erc20_mainnet.tokens.filter(t => t.address == root)[0]
        erc20_matic_new.push({
          ...origin_token,
          address: child,
          chainId: 137,
          //@ts-ignore
          extensions: {
            //@ts-ignore
            ...(origin_token.extensions ? origin_token.extensions  : {}),
            originChainId: origin_token.chainId,
            originAddress: origin_token.address
          }
        })
      }
    } else if (erc1155_addresses_mainnet.includes(root)) {
      if (!erc1155_addresses_matic.includes(child)) {
        const origin_token = erc1155_mainnet.tokens.filter(t => t.address == root)[0]
        erc1155_matic_new.push({
          ...origin_token,
          address: child,
          chainId: 137,
          extensions: {
            ...(origin_token.extensions ? origin_token.extensions  : {}),
            "originChainId": origin_token.chainId,
            "originAddress": origin_token.address
          }
        })
      }
    } else if (erc721_addresses_mainnet.includes(root)) {
      if (!erc721_addresses_matic.includes(child)) {
        const origin_token = erc721_mainnet.tokens.filter(t => t.address == root)[0]
        erc721_matic_new.push({
          ...origin_token,
          address: child,
          chainId: 137,
          extensions: {
            ...(origin_token.extensions ? origin_token.extensions  : {}),
            originChainId: origin_token.chainId,
            originAddress: origin_token.address
          }
        })
      }
    } else {
      console.log('Token does not exist on mainnet: ' + root)
    }
  }

  // Update Matic lists if new tokens are discovered
  if (erc20_matic_new.length > 0) {
    updateList(erc20_matic, erc20_matic_new, ERC20_LIST_PATH)
    console.log(`Added ${erc20_matic_new.length} tokens to Matic ERC-20 list`)
  } else {
    console.log('Matic ERC-20 list already up to date.')
  }

  if (erc721_matic_new.length > 0) {
    updateList(erc721_matic, erc721_matic_new, ERC721_LIST_PATH)
    console.log(`Added ${erc721_matic_new.length} tokens to Matic ERC-721 list`)
  } else {
    console.log('Matic ERC-721 list already up to date.')
  }

  if (erc1155_matic_new.length > 0) {
    updateList(erc1155_matic, erc1155_matic_new, ERC1155_LIST_PATH)
    console.log(`Added ${erc1155_matic_new.length} tokens to Matic ERC-1155 list`)
  } else {
    console.log('Matic ERC-1155 list already up to date.')
  }

}

main()
  .then(() => {
    console.log("Finished")
  })
  .catch((error) => {
    console.error(error)
  })

function updateList(oldList: TokenList | CollectibleList, newTokens: TokenInfo[] | CollectibleInfo[], savePath: string) {
  //@ts-ignore
  const newTokensList = oldList.tokens.concat(...newTokens)
  fs.writeFile(
    savePath,
    JSON.stringify({
      ...oldList,
      tokens: newTokensList,
      version: nextVersion(oldList.version, newTokensList.length > oldList.tokens.length ? VersionUpgrade.MINOR : VersionUpgrade.PATCH)
    }),
    { flag: "w+" },
    function (err) {
      if (err) throw err
    }
  )
}