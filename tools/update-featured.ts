import path from 'node:path'
import { readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { parseArgs } from 'node:util'

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

const NATIVE_ADDRESSES = new Set([
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '0x0000000000000000000000000000000000000000',
])

// Tokens pinned to the top of the featured list (after native), in order.
// Global pins apply to all chains, chain-specific pins come after.
const GLOBAL_PINNED_SYMBOLS = ['usdc', 'usdt', 'dai']

const CHAIN_PINNED_SYMBOLS: Record<string, string[]> = {
  mainnet: ['weth'],
  arbitrum: ['weth', 'arb'],
  optimism: ['weth', 'op'],
  polygon: ['wmatic', 'wpol', 'pol', 'matic'],
  base: ['weth'],
  avalanche: ['wavax', 'avax'],
  bnb: ['wbnb', 'bnb'],
  gnosis: ['wxdai', 'gno'],
  'arbitrum-nova': ['weth', 'arb'],
}

const SUPPORTED_CHAINS: Record<string, string> = {
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

type MarketEntry = {
  id: string
  symbol: string
  name: string
  total_volume: number | null
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

async function fetchCoinList(
  apiKey: string
): Promise<Map<string, Map<string, string>>> {
  console.log('Fetching CoinGecko coin list with platforms...')
  const url = `${COINGECKO_API_BASE}/coins/list?include_platform=true`
  const response = await fetchWithRetry(url, { 'x-cg-pro-api-key': apiKey })

  if (!response.ok) {
    throw new Error(`CoinGecko /coins/list failed with status ${response.status}`)
  }

  const coins = (await response.json()) as CoinListEntry[]

  // Build map: platformId -> (lowercaseAddress -> coinGeckoId)
  const platformMap = new Map<string, Map<string, string>>()

  for (const coin of coins) {
    if (!coin.platforms) continue
    for (const [platformId, address] of Object.entries(coin.platforms)) {
      if (!address) continue
      let addressMap = platformMap.get(platformId)
      if (!addressMap) {
        addressMap = new Map()
        platformMap.set(platformId, addressMap)
      }
      addressMap.set(address.toLowerCase(), coin.id)
    }
  }

  console.log(
    `Built platform lookup: ${platformMap.size} platforms, ${coins.length} coins`
  )
  return platformMap
}

type ContractMarketEntry = {
  id: string
  symbol: string
  name: string
  market_data?: {
    total_volume?: Record<string, number>
  }
}

async function fetchCoinByContract(
  apiKey: string,
  platformId: string,
  address: string
): Promise<{ id: string; volume: number } | null> {
  const url =
    `${COINGECKO_API_BASE}/coins/${platformId}/contract/${address.toLowerCase()}`
  const response = await fetchWithRetry(url, { 'x-cg-pro-api-key': apiKey })

  if (!response.ok) return null

  const data = (await response.json()) as ContractMarketEntry
  const volume = data.market_data?.total_volume?.usd ?? 0
  return { id: data.id, volume }
}

async function fetchMarketData(
  apiKey: string,
  ids: string[]
): Promise<MarketEntry[]> {
  const results: MarketEntry[] = []
  const batchSize = 250

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize)
    const idsParam = batch.join(',')
    const url =
      `${COINGECKO_API_BASE}/coins/markets` +
      `?vs_currency=usd&ids=${idsParam}&order=volume_desc&per_page=${batchSize}&page=1`

    const response = await fetchWithRetry(url, { 'x-cg-pro-api-key': apiKey })

    if (!response.ok) {
      console.warn(
        `CoinGecko /coins/markets batch failed with status ${response.status}`
      )
      continue
    }

    const data = (await response.json()) as MarketEntry[]
    results.push(...data)

    if (i + batchSize < ids.length) {
      await sleep(500)
    }
  }

  return results
}

async function processChain(
  chain: string,
  platformId: string,
  platformMap: Map<string, Map<string, string>>,
  apiKey: string,
  count: number,
  write: boolean
): Promise<void> {
  const tokenListPath = path.join(TOKEN_DIRECTORY_ROOT, chain, 'erc20.json')

  let raw: string
  try {
    raw = await fs.readFile(tokenListPath, 'utf-8')
  } catch {
    console.warn(`[${chain}] No erc20.json found, skipping.`)
    return
  }

  const tokenList = JSON.parse(raw) as TokenList
  const addressMap = platformMap.get(platformId) ?? new Map<string, string>()

  // Resolve CoinGecko IDs for non-native tokens
  const coinIdToAddresses = new Map<string, string[]>()
  const resolvedIds: string[] = []

  for (const token of tokenList.tokens) {
    const addrLower = token.address.toLowerCase()
    if (NATIVE_ADDRESSES.has(addrLower)) continue

    // Skip derivative tokens (aTokens, etc.) — their CoinGecko volume
    // reflects the underlying asset, not the wrapper itself
    if (token.extensions?.aaveAToken) continue

    const coinId = addressMap.get(addrLower)
    if (!coinId) continue

    const addrs = coinIdToAddresses.get(coinId) ?? []
    addrs.push(token.address)
    coinIdToAddresses.set(coinId, addrs)

    if (addrs.length === 1) {
      resolvedIds.push(coinId)
    }
  }

  // Collect unresolved non-native, non-derivative tokens for fallback
  const unresolvedTokens: TokenListEntry[] = []
  for (const token of tokenList.tokens) {
    const addrLower = token.address.toLowerCase()
    if (NATIVE_ADDRESSES.has(addrLower)) continue
    if (token.extensions?.aaveAToken) continue
    if (coinIdToAddresses.has(addressMap.get(addrLower) ?? '')) continue
    unresolvedTokens.push(token)
  }

  const eligible = resolvedIds.length + unresolvedTokens.length
  const maxFallback = 50
  const willFallback = unresolvedTokens.length > 0 && unresolvedTokens.length <= maxFallback
  console.log(
    `[${chain}] Resolved ${resolvedIds.length}/${eligible} eligible tokens via bulk lookup` +
      (willFallback
        ? `, falling back to contract lookup for ${unresolvedTokens.length} more...`
        : unresolvedTokens.length > maxFallback
          ? ` (skipping fallback for ${unresolvedTokens.length} unresolved — too many)`
          : '')
  )

  // Fallback: per-token contract lookup for unresolved tokens (only when manageable)
  const fallbackMarket: MarketEntry[] = []
  for (const token of willFallback ? unresolvedTokens : []) {
    const result = await fetchCoinByContract(apiKey, platformId, token.address)
    if (!result) continue

    const addrs = coinIdToAddresses.get(result.id) ?? []
    addrs.push(token.address)
    coinIdToAddresses.set(result.id, addrs)

    if (addrs.length === 1) {
      resolvedIds.push(result.id)
      fallbackMarket.push({
        id: result.id,
        symbol: token.symbol,
        name: token.name,
        total_volume: result.volume,
      })
    }

    await sleep(200)
  }

  if (fallbackMarket.length) {
    console.log(
      `[${chain}] Resolved ${fallbackMarket.length} more via contract fallback (total: ${resolvedIds.length})`
    )
  }

  if (!resolvedIds.length) {
    console.warn(`[${chain}] No tokens resolved, skipping.`)
    return
  }

  // Fetch market data sorted by volume (bulk-resolved tokens)
  const marketData = await fetchMarketData(apiKey, resolvedIds)

  // Merge in fallback results (they already have volume from contract lookup)
  for (const fb of fallbackMarket) {
    if (!marketData.some(m => m.id === fb.id)) {
      marketData.push(fb)
    }
  }

  // Re-sort by volume descending after merge
  marketData.sort(
    (a, b) => (b.total_volume ?? 0) - (a.total_volume ?? 0)
  )

  // Filter to those with volume and take top N
  const ranked = marketData
    .filter(m => m.total_volume != null && m.total_volume > 0)
    .slice(0, count)

  // Build set of all resolved addresses (tokens the script knows about)
  const resolvedAddresses = new Set<string>()
  for (const addrs of coinIdToAddresses.values()) {
    for (const addr of addrs) {
      resolvedAddresses.add(addr.toLowerCase())
    }
  }

  // Pin stablecoins and chain-specific tokens to the top
  const pinOrder = [
    ...GLOBAL_PINNED_SYMBOLS,
    ...(CHAIN_PINNED_SYMBOLS[chain] ?? []),
  ]
  // Pull pinned tokens out of ranked list and prepend in pin order
  const pinned: MarketEntry[] = []
  for (const sym of pinOrder) {
    const idx = ranked.findIndex(m => m.symbol.toLowerCase() === sym)
    if (idx !== -1) {
      const [entry] = ranked.splice(idx, 1)
      pinned.push(entry)
    }
  }
  ranked.unshift(...pinned)

  // Build set of addresses that should be featured (by volume rank)
  // Native tokens share featureIndex 1, ERC-20s start at 2
  const featuredAddresses = new Map<string, number>()
  let rank = 2
  for (const entry of ranked) {
    const addresses = coinIdToAddresses.get(entry.id) ?? []
    for (const addr of addresses) {
      featuredAddresses.set(addr.toLowerCase(), rank)
      rank++
    }
  }

  // Track old featureIndex for reporting
  const oldFeatured = new Map<string, number>()
  for (const token of tokenList.tokens) {
    if (token.extensions?.featureIndex != null) {
      oldFeatured.set(
        token.address.toLowerCase(),
        token.extensions.featureIndex as number
      )
    }
  }

  // Apply changes — only touch tokens we actually resolved on CoinGecko
  for (const token of tokenList.tokens) {
    const addrLower = token.address.toLowerCase()

    // Native tokens: always featureIndex 1 (0xeeee and 0x0000 share the same index)
    if (NATIVE_ADDRESSES.has(addrLower)) {
      if (!token.extensions) token.extensions = {}
      token.extensions.featureIndex = 1
      continue
    }

    // Skip tokens we couldn't resolve — leave them exactly as-is
    if (!resolvedAddresses.has(addrLower)) continue

    const newRank = featuredAddresses.get(addrLower)
    if (newRank != null) {
      // Token is in top N — only update featureIndex, don't touch featured
      if (!token.extensions) token.extensions = {}
      token.extensions.featureIndex = newRank
    } else if (token.extensions?.featureIndex != null) {
      // Resolved but not in top N: remove featureIndex only
      delete token.extensions.featureIndex
      // Clean up empty extensions
      if (Object.keys(token.extensions).length === 0) {
        delete token.extensions
      }
    }
  }

  // Print proposed changes
  console.log(`\n[${chain}] Proposed featured order:`)

  // Native tokens
  for (const token of tokenList.tokens) {
    if (NATIVE_ADDRESSES.has(token.address.toLowerCase())) {
      console.log(`  #1  ${token.symbol} (${token.address}) [native]`)
    }
  }

  // Ranked tokens
  for (const entry of ranked) {
    const addresses = coinIdToAddresses.get(entry.id) ?? []
    for (const addr of addresses) {
      const addrLower = addr.toLowerCase()
      const token = tokenList.tokens.find(
        t => t.address.toLowerCase() === addrLower
      )
      if (!token) continue
      const newRank = featuredAddresses.get(addrLower)!
      const oldRank = oldFeatured.get(addrLower)
      const status = oldRank != null ? `was #${oldRank}` : 'NEW'
      const vol = entry.total_volume != null
        ? `$${entry.total_volume.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
        : 'n/a'
      console.log(`  #${newRank}  ${token.symbol} (${token.address}) vol=${vol} [${status}]`)
    }
  }

  // Removed tokens
  for (const [addrLower, oldRank] of oldFeatured) {
    if (NATIVE_ADDRESSES.has(addrLower)) continue
    if (featuredAddresses.has(addrLower)) continue
    const token = tokenList.tokens.find(
      t => t.address.toLowerCase() === addrLower
    )
    if (token) {
      console.log(
        `  Removed: ${token.symbol} (${token.address}) [was #${oldRank}]`
      )
    }
  }

  // Only write when --write is passed
  if (!write) return

  await fs.writeFile(tokenListPath, `${JSON.stringify(tokenList, null, 2)}\n`)
  console.log(`[${chain}] Wrote ${tokenListPath}`)
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

  const chains = chainFilter
    ? { [chainFilter]: SUPPORTED_CHAINS[chainFilter] }
    : SUPPORTED_CHAINS

  if (chainFilter && !SUPPORTED_CHAINS[chainFilter]) {
    console.error(
      `Unknown chain "${chainFilter}". Supported: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`
    )
    process.exitCode = 1
    return
  }

  // Fetch the full coin list once
  const platformMap = await fetchCoinList(apiKey)

  const chainEntries = Object.entries(chains)
  for (let i = 0; i < chainEntries.length; i++) {
    const [chain, platformId] = chainEntries[i]
    await processChain(chain, platformId, platformMap, apiKey, count, write)

    if (i < chainEntries.length - 1) {
      await sleep(500)
    }
  }

  console.log('\nDone.')
}

main().catch(error => {
  console.error('Failed to update featured tokens:', error)
  process.exitCode = 1
})
