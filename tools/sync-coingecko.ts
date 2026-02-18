import path from 'node:path'
import { readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { parseArgs } from 'node:util'
import { getAddress } from 'viem'

// Load .env file if present (no external deps)
try {
  const envFile = readFileSync(path.resolve('.env'), 'utf-8')
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
} catch {
  // No .env file, that's fine
}

const TOKEN_DIRECTORY_ROOT = path.resolve('./index')

const COINGECKO_API_BASE = 'https://pro-api.coingecko.com/api/v3'

// Chain folder name -> CoinGecko category slug (for /coins/markets?category=)
const CHAIN_CATEGORIES: Record<string, string> = {
  mainnet: 'ethereum-ecosystem',
  arbitrum: 'arbitrum-ecosystem',
  polygon: 'polygon-ecosystem',
  optimism: 'optimism-ecosystem',
  base: 'base-ecosystem',
  avalanche: 'avalanche-ecosystem',
  bnb: 'binance-smart-chain',
  gnosis: 'xdai-ecosystem',
  'arbitrum-nova': 'arbitrum-nova-ecosystem',
}

// Chain folder name -> CoinGecko platform ID (for contract address lookup)
const CHAIN_PLATFORMS: Record<string, string> = {
  mainnet: 'ethereum',
  arbitrum: 'arbitrum-one',
  polygon: 'polygon-pos',
  optimism: 'optimistic-ethereum',
  base: 'base',
  avalanche: 'avalanche',
  bnb: 'binance-smart-chain',
  gnosis: 'xdai',
  'arbitrum-nova': 'arbitrum-nova',
}

// Chain folder name -> chainId
const CHAIN_IDS: Record<string, number> = {
  mainnet: 1,
  arbitrum: 42161,
  polygon: 137,
  optimism: 10,
  base: 8453,
  avalanche: 43114,
  bnb: 56,
  gnosis: 100,
  'arbitrum-nova': 42170,
}

type TokenListEntry = {
  chainId: number
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI: string
  extensions?: Record<string, unknown>
}

type TokenList = {
  name: string
  chainId: number
  tokenStandard: 'erc20'
  logoURI: string
  keywords: string[]
  tokens: TokenListEntry[]
  timestamp?: string
  version?: {
    major: number
    minor: number
    patch: number
  }
}

type CoinListEntry = {
  id: string
  symbol: string
  name: string
  platforms: Record<string, string>
}

type MarketsEntry = {
  id: string
  symbol: string
  name: string
  image: string
  total_volume: number | null
}

type ContractResponse = {
  detail_platforms?: Record<
    string,
    { decimal_place: number | null; contract_address: string }
  >
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, { headers })

    if (response.status === 429 && attempt < maxRetries) {
      const backoff = Math.pow(2, attempt + 1) * 1000
      console.warn(`Rate limited, retrying in ${backoff}ms...`)
      await sleep(backoff)
      continue
    }

    return response
  }

  throw new Error(`Max retries exceeded for ${url}`)
}

// Build map: coinGeckoId -> (platformId -> address)
async function fetchCoinPlatforms(
  apiKey: string
): Promise<Map<string, Map<string, string>>> {
  console.log('Fetching CoinGecko coin list with platforms...')
  const url = `${COINGECKO_API_BASE}/coins/list?include_platform=true`
  const response = await fetchWithRetry(url, { 'x-cg-pro-api-key': apiKey })

  if (!response.ok) {
    throw new Error(
      `CoinGecko /coins/list failed with status ${response.status}`
    )
  }

  const coins = (await response.json()) as CoinListEntry[]
  const coinPlatforms = new Map<string, Map<string, string>>()

  for (const coin of coins) {
    if (!coin.platforms) continue
    const platforms = new Map<string, string>()
    for (const [platformId, address] of Object.entries(coin.platforms)) {
      if (!address) continue
      platforms.set(platformId, address.toLowerCase())
    }
    if (platforms.size > 0) {
      coinPlatforms.set(coin.id, platforms)
    }
  }

  console.log(
    `Built coin platform lookup: ${coinPlatforms.size} coins with platform addresses`
  )
  return coinPlatforms
}

async function fetchCategoryMarkets(
  apiKey: string,
  category: string,
  count: number
): Promise<MarketsEntry[]> {
  const url =
    `${COINGECKO_API_BASE}/coins/markets` +
    `?vs_currency=usd&category=${category}&order=volume_desc&per_page=${count}&page=1`

  const response = await fetchWithRetry(url, { 'x-cg-pro-api-key': apiKey })

  if (!response.ok) {
    throw new Error(
      `CoinGecko /coins/markets?category=${category} failed with status ${response.status}`
    )
  }

  return (await response.json()) as MarketsEntry[]
}

async function fetchDecimals(
  apiKey: string,
  platformId: string,
  address: string
): Promise<number | null> {
  const url = `${COINGECKO_API_BASE}/coins/${platformId}/contract/${address}`
  const response = await fetchWithRetry(url, { 'x-cg-pro-api-key': apiKey })

  if (!response.ok) return null

  const data = (await response.json()) as ContractResponse
  return data.detail_platforms?.[platformId]?.decimal_place ?? null
}

async function processChain(
  chain: string,
  coinPlatforms: Map<string, Map<string, string>>,
  apiKey: string,
  count: number,
  write: boolean
): Promise<void> {
  const category = CHAIN_CATEGORIES[chain]
  const platformId = CHAIN_PLATFORMS[chain]
  const chainId = CHAIN_IDS[chain]
  const tokenListPath = path.join(TOKEN_DIRECTORY_ROOT, chain, 'erc20.json')

  // Load existing token list
  let tokenList: TokenList
  try {
    const raw = await fs.readFile(tokenListPath, 'utf-8')
    tokenList = JSON.parse(raw) as TokenList
  } catch {
    console.warn(`[${chain}] No erc20.json found, skipping.`)
    return
  }

  const existingAddresses = new Set(
    tokenList.tokens.map(t => t.address.toLowerCase())
  )

  // Fetch top tokens by volume for this chain's category
  console.log(`[${chain}] Fetching top ${count} tokens from category ${category}...`)
  const markets = await fetchCategoryMarkets(apiKey, category, count)
  console.log(`[${chain}] Got ${markets.length} tokens from CoinGecko markets`)

  // Match market tokens to contract addresses on this chain
  const newTokens: {
    market: MarketsEntry
    address: string
  }[] = []

  for (const market of markets) {
    const platforms = coinPlatforms.get(market.id)
    if (!platforms) continue

    const address = platforms.get(platformId)
    if (!address) continue

    if (existingAddresses.has(address)) continue

    newTokens.push({ market, address })
  }

  if (!newTokens.length) {
    console.log(`[${chain}] No new tokens to add.`)
    return
  }

  console.log(
    `[${chain}] Found ${newTokens.length} new tokens, fetching decimals...`
  )

  // Fetch decimals for each new token
  const additions: TokenListEntry[] = []
  for (let i = 0; i < newTokens.length; i++) {
    const { market, address } = newTokens[i]

    const decimals = await fetchDecimals(apiKey, platformId, address)
    if (decimals == null) {
      console.warn(
        `  [${chain}] Skipping ${market.symbol} (${address}): could not resolve decimals`
      )
      if (i < newTokens.length - 1) await sleep(200)
      continue
    }

    additions.push({
      chainId,
      address: getAddress(address),
      name: market.name,
      symbol: market.symbol.toUpperCase(),
      decimals,
      logoURI: market.image ?? '',
      extensions: {
        coingeckoId: market.id,
      },
    })

    if (i < newTokens.length - 1) await sleep(200)
  }

  if (!additions.length) {
    console.log(`[${chain}] No tokens with resolved decimals to add.`)
    return
  }

  // Print what would be added
  console.log(`\n[${chain}] ${write ? 'Adding' : 'Would add'} ${additions.length} tokens:`)
  if (additions.length > 0) {
    console.log(`\nExample entry:`)
    console.log(JSON.stringify(additions[0], null, 2))
    if (additions.length > 1) {
      console.log(`\n... and ${additions.length - 1} more:`)
    }
  }
  for (const token of additions) {
    const vol = newTokens.find(
      t => t.address === token.address
    )?.market.total_volume
    const volStr =
      vol != null
        ? `$${vol.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
        : 'n/a'
    console.log(
      `  ${token.symbol} (${token.address}) decimals=${token.decimals} vol=${volStr}`
    )
  }

  if (!write) {
    console.log(`[${chain}] Dry run — pass --write to apply changes.`)
    return
  }

  tokenList.tokens.push(...additions)
  await fs.writeFile(tokenListPath, `${JSON.stringify(tokenList, null, 2)}\n`)
  console.log(`[${chain}] Wrote ${additions.length} new tokens to ${tokenListPath}`)
}

const main = async () => {
  const args = process.argv.slice(2).filter(a => a !== '--')
  const { values } = parseArgs({
    args,
    options: {
      write: { type: 'boolean', default: false },
      chain: { type: 'string' },
      count: { type: 'string', default: '50' },
    },
    strict: true,
  })

  const write = values.write ?? false
  const chainFilter = values.chain
  const count = parseInt(values.count!, 10)

  if (isNaN(count) || count < 1) {
    console.error('Invalid --count value')
    process.exitCode = 1
    return
  }

  const apiKey = process.env.COINGECKO_API_KEY
  if (!apiKey) {
    console.error('COINGECKO_API_KEY environment variable is required')
    process.exitCode = 1
    return
  }

  if (chainFilter && !CHAIN_CATEGORIES[chainFilter]) {
    console.error(
      `Unknown chain "${chainFilter}". Supported: ${Object.keys(CHAIN_CATEGORIES).join(', ')}`
    )
    process.exitCode = 1
    return
  }

  const chains = chainFilter ? [chainFilter] : Object.keys(CHAIN_CATEGORIES)

  // Fetch the full coin list once to build address lookup
  const coinPlatforms = await fetchCoinPlatforms(apiKey)

  for (let i = 0; i < chains.length; i++) {
    const chain = chains[i]
    await processChain(chain, coinPlatforms, apiKey, count, write)

    if (i < chains.length - 1) {
      await sleep(500)
    }
  }

  console.log('\nDone.')
}

main().catch(error => {
  console.error('Failed to sync CoinGecko tokens:', error)
  process.exitCode = 1
})
