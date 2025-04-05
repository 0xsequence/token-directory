import * as fs from "fs"
import * as ethers from 'ethers'
import fetch from "node-fetch"
import { nextVersion, schema, VersionUpgrade, CollectibleList, CollectibleInfo } from '@0xsequence/collectible-lists'
import { getEnvConfig } from "../src/utils"
const Ajv = require("ajv")
const isEqual = require("lodash.isequal")
const cliProgress = require('cli-progress');

// Loading jsons
const erc721json = require("@openzeppelin/contracts/build/contracts/ERC721.json")
const erc721Dump: TokenDump[] = require("../src/data/erc721_dune_dump_2021_01_20.json")
const erc721: CollectibleList = require("../../index/mainnet/erc721.json")

// Build ERC-721 list
// 1. Load crv dump from Dune analytics
// 2. Query contract info via opensea API
// 3. Build list according to @0xsequence/collectible-lists

// Manually tracked ERC-721
const missingTokens = [
  '0xf5b0a3efb8e8e4c201e2a935f110eaaf3ffecb8d', // Axie infinity
  '0x06012c8cf97bead5deae237070f9587f8e7a266d'  // Cryptokitties
]

// List to fetch
const ERC721_LIST_PATH = "../index/mainnet/erc721.json"
const config = getEnvConfig()
const provider = new ethers.providers.InfuraProvider('mainnet', config['INFURA_API_KEY'])

interface TokenDump {
  name: string;
  contract_address: string;
  n_transfers: number;
}

// Building list
const main = async () => {

  // Create token information array
  let newCollectibleList: CollectibleInfo[] = []
  const erc721Contracts: string[] = [...new Set([...missingTokens, ...erc721Dump.map(t => t.contract_address)])]
  const errors: any = []

  // Progress bar init
  console.log('Building ERC-721 mainnet list')
  const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  progressBar.start(erc721Contracts.length, 0)
  for (let i= 0; i < erc721Contracts.length; i++) {
    let resp
    try {
      resp = await fetch('https://api.opensea.io/api/v1/asset_contract/' + erc721Contracts[i])
    } catch (err) {
      console.log(err)
    }
    while (resp && resp.status == 429) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        resp = await fetch('https://api.opensea.io/api/v1/asset_contract/' + erc721Contracts[i])
      } catch (err) {
        console.log(err)
      }
    }
    if (!resp || !resp.ok) {
      errors.push({
        id: i,
        address: erc721Contracts[i],
        resp: !resp ? null : resp.status + ' - ' + resp.statusText
      })
      progressBar.update(i+1)
      continue
    }
    const info = await resp.json()
    
    // Query symbol on contract if couldn't find it
    let validSymbol
    if (!info.symbol || info.symbol === "") {
      const erc721contract = new ethers.Contract(erc721Contracts[i], erc721json.abi, provider)
      try {
        validSymbol = await erc721contract.symbol()
      } catch {
        validSymbol = ""
      }
    } else {
      validSymbol = info.symbol
    }
    
    // Force some basic validation so they are compatible with schema
    validSymbol = validSymbol.length <= 20 ? validSymbol : validSymbol.slice(0,20)
    const validName = !info.name || info.name.length <= 64 ? info.name : info.name.slice(0,64)
    const validDescription = !info.description || info.description.length <= 1000 ? info.description : info.description.slice(0,997) + '...'

    // Append token to list
    newCollectibleList.push({
      chainId: 1,
      address: erc721Contracts[i],
      name: validName,
      standard: "erc721",
      symbol: validSymbol === "" ? null : validSymbol,
      logoURI: !info.image_url || info.image_url === "" ? null : info.image_url,
      extensions: {
        "link": !info.external_link || info.external_link === "" ? null : info.external_link,
        "description": !validDescription || validDescription === "" ? null : validDescription
      }
    })

    progressBar.update(i+1)
  }
  progressBar.stop()

  // Print contracts that were ignored and why
  if (errors.length > 0) {
    console.log('Contracts ignored')
    console.log(errors)
    console.log('\n')
  }

  // Validate the list fetched against current CollectibleList schema1
  const ajv = new Ajv()
  const validateList = ajv.compile(schema)

  // Update token list version
  // Increment minor version when tokens are added
  // Increment patch version when tokens already on the list have details changed
  const newErc721List = {
    ...erc721,
    timestamp: (new Date()).toISOString(),
    tokens: newCollectibleList,
    version: nextVersion(erc721.version, newCollectibleList.length > erc721.tokens.length ? VersionUpgrade.MINOR : VersionUpgrade.PATCH)
  }

  // Validate list against schema
  if (!validateList(newErc721List)) {
    console.log("New list has invalid schema: ")
    console.log(validateList.errors)
    //throw Error("^^^")
  }
    
  // Check whether list changed or not (except version)
  if (isEqual(newErc721List.tokens, erc721.tokens)) {
    console.log("List is already up-to-date")
    return
  } 

  // Store latest erc-721 tokens list
  fs.writeFile(
    ERC721_LIST_PATH,
    JSON.stringify(newErc721List),
    { flag: "w+" },
    function (err) {
      if (err) throw err
      console.log("ERC-721 Mainnet List Updated")
    }
  )
}

main()
  .then(() => {
    console.log("Finished")
  })
  .catch((error) => {
    console.error(error)
  })
