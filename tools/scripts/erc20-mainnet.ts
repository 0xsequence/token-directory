import * as fs from "fs"
const Ajv = require("ajv")
import fetch from "node-fetch"
import * as ethers from 'ethers'
import { TokenList, schema, nextVersion, VersionUpgrade } from "@uniswap/token-lists"
import { getEnvConfig } from "../src/utils"
const isEqual = require("lodash.isequal")
const cliProgress = require('cli-progress');
const erc20json = require("@openzeppelin/contracts/build/contracts/ERC20.json")
const erc20: TokenList = require("../../index/mainnet/erc20.json")

// List to fetch
const ERC20_LIST_URL = "https://tokens.coingecko.com/uniswap/all.json"
const ERC20_LIST_PATH = "../index/mainnet/erc20.json"
const config = getEnvConfig()
const provider = new ethers.providers.InfuraProvider('mainnet', config['INFURA_API_KEY'])

const main = async () => {
  // Fetch ERC-20 token list
  const newList: TokenList = await (await fetch(ERC20_LIST_URL)).json()

  // Enchance coingecko list with description and link
  console.log('Fetch ERC20 tokens information')
  const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  progressBar.start(newList.tokens.length, 0)
  for (let i=0; i < newList.tokens.length; i++) {
    let resp = await fetch('https://api.coingecko.com/api/v3/coins/ethereum/contract/' + newList.tokens[i].address)
    while (resp.status == 429) {
      await new Promise(r => setTimeout(r, 5000));
      resp = await fetch('https://api.coingecko.com/api/v3/coins/ethereum/contract/' + newList.tokens[i].address)
    }
    if (!resp.ok) {
      console.log('Error: ' + resp.statusText)
      progressBar.update(i+1)
      continue
    }
    const info = await resp.json()

    let validSymbol
    if (!info.symbol || info.symbol === "") {
      const erc20contract = new ethers.Contract(newList.tokens[i].address, erc20json.abi, provider)
      try {
        validSymbol = await erc20contract.symbol()
      } catch {
        validSymbol = ""
      }
    } else {
      validSymbol = info.symbol
    }

    validSymbol = validSymbol.length <= 20 ? validSymbol : validSymbol.slice(0,20)
    const validDescription = !info.description.en || info.description.en.length <= 1000 ? info.description.en : info.description.en.slice(0,997) + '...'

    newList.tokens[i] = {
      ...newList.tokens[i],
      //@ts-ignore
      extensions: {
        "link": !info.links.homepage[0] || info.links.homepage[0] === "" ? null : info.links.homepage[0],
        "description": !validDescription || validDescription === "" ? null : validDescription
      }
    }
    
    progressBar.update(i+1)
  }
  progressBar.stop()

  const newErc20List = {
    ...newList,
    timestamp: (new Date()).toISOString(),
    tokens: newList.tokens,
    version: nextVersion(erc20.version, newList.tokens.length > erc20.tokens.length ? VersionUpgrade.MINOR : VersionUpgrade.PATCH)
  }

  // Validate the list fetched against current TokenList schema1
  const ajv = new Ajv()
  const validateList = ajv.compile(schema)

  // Validate list against schema
  if (!validateList(newErc20List)) {
    console.log("New list has invalid schema: ")
    //console.log(validateList.errors)
    //throw Error("^^^")
  }

  // Check whether list changed or not
  if (isEqual(newErc20List.tokens, erc20.tokens)) {
    console.log("List is already up-to-date")
    return
  } 

  // Store latest erc-20 tokens list
  fs.writeFile(
    ERC20_LIST_PATH,
    JSON.stringify(newErc20List),
    { flag: "w+" },
    function (err) {
      if (err) throw err
      console.log("ERC-20 Mainnet List Updated")
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
