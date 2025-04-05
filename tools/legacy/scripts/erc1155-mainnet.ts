import * as fs from "fs"
import * as ethers from 'ethers'
import fetch from "node-fetch"
import { nextVersion, schema, VersionUpgrade, CollectibleList, CollectibleInfo } from '@0xsequence/collectible-lists'
import { getEnvConfig } from "../src/utils"
const Ajv = require("ajv")
const isEqual = require("lodash.isequal")
const cliProgress = require('cli-progress');

// Loading jsons
const erc1155json = require("@openzeppelin/contracts/build/contracts/ERC1155.json")
const erc1155Dump: TokenDump[] = require("../src/data/erc1155_dune_dump_2021_01_25.json")
const erc1155: CollectibleList = require("../../index/mainnet/erc1155.json")

// Build ERC-1155 list
// 1. Load crv dump from Dune analytics
// 2. Query contract info via opensea API
// 3. Build list according to @0xsequence/collectible-lists

// List to fetch
const ERC1155_LIST_PATH = "../index/mainnet/erc1155.json"
const config = getEnvConfig()
const provider = new ethers.providers.InfuraProvider('mainnet', config['INFURA_API_KEY'])

interface TokenDump {
  name: string;
  address: string;
  n_transfers: number;
}

// Building list
const main = async () => {

  // Create token information array
  let newCollectibleList: CollectibleInfo[] = []
  const erc1155Contracts: string[] = [...new Set([...erc1155Dump.map(t => t.address)])]
  const errors: any = []

  // Progress bar init
  console.log('Building ERC-1155 mainnet list')
  const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  progressBar.start(erc1155Contracts.length, 0)
  for (let i= 0; i < erc1155Contracts.length; i++) {
    let resp
    try {
      resp = await fetch('https://api.opensea.io/api/v1/asset_contract/' + erc1155Contracts[i])
    } catch (err) {
      console.log(err)
    }
    while (resp && resp.status == 429) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        resp = await fetch('https://api.opensea.io/api/v1/asset_contract/' + erc1155Contracts[i])
      } catch (err) {
        console.log(err)
      }
    }
    if (!resp || !resp.ok) {
      errors.push({
        id: i,
        address: erc1155Contracts[i],
        resp: !resp ? null : resp.status + ' - ' + resp.statusText
      })
      progressBar.update(i+1)
      continue
    }
    const info = await resp.json()
    
    // Query symbol on contract if couldn't find it
    let validSymbol
    if (!info.symbol || info.symbol === "") {
      const erc1155contract = new ethers.Contract(erc1155Contracts[i], erc1155json.abi, provider)
      try {
        validSymbol = await erc1155contract.symbol()
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
      address: erc1155Contracts[i],
      name: validName,
      standard: "erc1155",
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
  const newErc1155List = {
    ...erc1155,
    timestamp: (new Date()).toISOString(),
    tokens: newCollectibleList,
    version: nextVersion(erc1155.version, newCollectibleList.length > erc1155.tokens.length ? VersionUpgrade.MINOR : VersionUpgrade.PATCH)
  }

  // Validate list against schema
  if (!validateList(newErc1155List)) {
    console.log("New list has invalid schema: ")
    console.log(validateList.errors)
    //throw Error("^^^")
  }
    
  // Check whether list changed or not (except version)
  if (isEqual(newErc1155List.tokens, erc1155.tokens)) {
    console.log("List is already up-to-date")
    return
  } 

  // Store latest erc-1155 tokens list
  fs.writeFile(
    ERC1155_LIST_PATH,
    JSON.stringify(newErc1155List),
    { flag: "w+" },
    function (err) {
      if (err) throw err
      console.log("ERC-1155 Mainnet List Updated")
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
