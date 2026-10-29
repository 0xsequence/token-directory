import path from 'node:path'
import { promises as fs } from 'node:fs'
import { parseArgs } from 'node:util'

const TOKEN_DIRECTORY_ROOT = path.resolve('./index')

const GOPLUS_API_BASE = 'https://api.gopluslabs.io/api/v1/token_security'

// GoPlus computes a fresh report only for single-address requests; multi-address
// requests return just the entries it already has cached. Requests are therefore
// serial. Spacing keeps most requests under the unauthenticated limit; the limit is
// not a fixed window, so occasional rate-limit responses are expected and retried.
const REQUEST_DELAY_MS = 4000
const MAX_BACKOFF_MS = 60000
const RATE_LIMITED_CODE = 4029

// Cached responses keyed `chainId:address`, so an interrupted scan resumes without
// re-querying. Transfer semantics do not change for a non-upgradeable token.
const CACHE_PATH = path.resolve('./tools/.fee-on-transfer-cache.json')

// Chain folder name -> chainId, limited to chains GoPlus covers
// (https://api.gopluslabs.io/api/v1/supported_chains).
const CHAIN_IDS: Record<string, number> = {
  mainnet: 1,
  polygon: 137,
  base: 8453,
  optimism: 10,
  arbitrum: 42161,
  avalanche: 43114,
  bnb: 56,
  gnosis: 100,
  berachain: 80094,
  soneium: 1868,
  sonic: 146,
  monad: 143,
}

const NATIVE_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
])

type TokenListEntry = {
  chainId: number
  address: string
  name: string
  symbol?: string
  decimals?: number
  logoURI?: string
  extensions?: Record<string, unknown>
}

type TokenList = {
  tokens: TokenListEntry[]
}

type TokenSecurity = {
  token_symbol?: string
  transfer_tax?: string
  buy_tax?: string
  sell_tax?: string
}

type TokenSecurityResponse = {
  code: number
  message?: string
  result?: Record<string, TokenSecurity>
}

type CacheEntry = { transferTax: number | null }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A tax rate is only meaningful when GoPlus returns a parseable number. An empty
 * string means it did not compute one, which is not the same as zero.
 */
function parseTaxRate(rate: string | undefined): number | null {
  if (rate == null || rate.trim() === '') return null
  const parsed = Number(rate)
  return Number.isFinite(parsed) ? parsed : null
}

async function fetchTokenSecurity(
  chainId: number,
  address: string,
  maxRetries = 6
): Promise<TokenSecurity> {
  const url = `${GOPLUS_API_BASE}/${chainId}?contract_addresses=${address}`

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetch(url)
    } catch (error) {
      // Transient DNS/socket failures must not end a scan of thousands of tokens.
      if (attempt === maxRetries) throw error
      const backoff = Math.min(2 ** (attempt + 1) * 5000, MAX_BACKOFF_MS)
      console.warn(`  Request failed, retrying in ${backoff}ms...`)
      await sleep(backoff)
      continue
    }

    if (!response.ok) {
      // 5xx is the upstream or its CDN failing, not a bad request; retry it.
      if (response.status >= 500 && attempt < maxRetries) {
        const backoff = Math.min(2 ** (attempt + 1) * 5000, MAX_BACKOFF_MS)
        console.warn(`  HTTP ${response.status}, retrying in ${backoff}ms...`)
        await sleep(backoff)
        continue
      }
      throw new Error(
        `GoPlus returned HTTP ${response.status} for ${chainId}:${address}`
      )
    }

    let body: TokenSecurityResponse
    try {
      body = (await response.json()) as TokenSecurityResponse
    } catch (error) {
      // A CDN error page parses as neither JSON nor a useful result.
      if (attempt === maxRetries) throw error
      const backoff = Math.min(2 ** (attempt + 1) * 5000, MAX_BACKOFF_MS)
      console.warn(`  Malformed response, retrying in ${backoff}ms...`)
      await sleep(backoff)
      continue
    }

    if (body.code === RATE_LIMITED_CODE && attempt < maxRetries) {
      const backoff = Math.min(2 ** (attempt + 1) * 5000, MAX_BACKOFF_MS)
      console.warn(`  Rate limited, retrying in ${backoff}ms...`)
      await sleep(backoff)
      continue
    }

    if (body.code === RATE_LIMITED_CODE) {
      throw new Error(
        `GoPlus rate limit not cleared after ${maxRetries} retries for ${chainId}:${address}`
      )
    }

    return body.result?.[address.toLowerCase()] ?? {}
  }

  throw new Error(`GoPlus request loop exhausted for ${chainId}:${address}`)
}

async function loadCache(): Promise<Record<string, CacheEntry>> {
  let raw: string
  try {
    raw = await fs.readFile(CACHE_PATH, 'utf-8')
  } catch {
    return {}
  }

  // A corrupt cache means silently rescanning everything, so surface it instead.
  try {
    return JSON.parse(raw) as Record<string, CacheEntry>
  } catch {
    throw new Error(
      `Cache at ${CACHE_PATH} is unreadable; delete it to rescan from scratch.`
    )
  }
}

async function saveCache(cache: Record<string, CacheEntry>): Promise<void> {
  // Written after every lookup, so a kill mid-write must not truncate the file.
  const tmp = `${CACHE_PATH}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`)
  await fs.rename(tmp, CACHE_PATH)
}

async function processChain(
  chain: string,
  write: boolean,
  cache: Record<string, CacheEntry>
): Promise<{ flagged: number; scanned: number; unknown: number }> {
  const chainId = CHAIN_IDS[chain]
  const tokenListPath = path.join(TOKEN_DIRECTORY_ROOT, chain, 'erc20.json')

  let tokenList: TokenList
  try {
    tokenList = JSON.parse(
      await fs.readFile(tokenListPath, 'utf-8')
    ) as TokenList
  } catch {
    console.warn(`[${chain}] No erc20.json found, skipping.`)
    return { flagged: 0, scanned: 0, unknown: 0 }
  }

  const candidates = tokenList.tokens.filter(
    token => !NATIVE_ADDRESSES.has(token.address.toLowerCase())
  )

  console.log(
    `[${chain}] Scanning ${candidates.length} tokens (~${Math.ceil(
      (candidates.length * REQUEST_DELAY_MS) / 60000
    )} min)...`
  )

  let flagged = 0
  let unknown = 0

  for (let i = 0; i < candidates.length; i++) {
    const token = candidates[i]
    const cacheKey = `${chainId}:${token.address.toLowerCase()}`

    let transferTax: number | null
    if (cacheKey in cache) {
      transferTax = cache[cacheKey].transferTax
    } else {
      const security = await fetchTokenSecurity(chainId, token.address)
      transferTax = parseTaxRate(security.transfer_tax)
      cache[cacheKey] = { transferTax }
      await saveCache(cache)
      if (i < candidates.length - 1) await sleep(REQUEST_DELAY_MS)
    }

    if (transferTax == null) {
      unknown++
      continue
    }
    if (transferTax === 0) continue

    flagged++
    console.log(
      `  [${chain}] ${token.symbol ?? token.name} (${token.address}) transfer_tax=${transferTax}`
    )

    token.extensions = { ...token.extensions, feeOnTransfer: true }
  }

  console.log(
    `[${chain}] ${write ? 'Flagged' : 'Would flag'} ${flagged} tokens` +
      ` (${unknown} without a transfer tax result).`
  )

  if (flagged > 0 && write) {
    await fs.writeFile(tokenListPath, `${JSON.stringify(tokenList, null, 2)}\n`)
    console.log(`[${chain}] Wrote ${tokenListPath}`)
  }

  return { flagged, scanned: candidates.length, unknown }
}

const main = async () => {
  const args = process.argv.slice(2).filter(a => a !== '--')
  const { values } = parseArgs({
    args,
    options: {
      write: { type: 'boolean', default: false },
      chain: { type: 'string' },
    },
    strict: true,
  })

  const write = values.write ?? false
  const chainFilter = values.chain

  if (chainFilter && !CHAIN_IDS[chainFilter]) {
    console.error(
      `Unknown chain "${chainFilter}". Supported: ${Object.keys(CHAIN_IDS).join(', ')}`
    )
    process.exitCode = 1
    return
  }

  const chains = chainFilter ? [chainFilter] : Object.keys(CHAIN_IDS)

  const cache = await loadCache()

  let flagged = 0
  let scanned = 0
  let unknown = 0
  const failed: string[] = []
  for (const chain of chains) {
    try {
      const result = await processChain(chain, write, cache)
      flagged += result.flagged
      scanned += result.scanned
      unknown += result.unknown
    } catch (error) {
      // One chain failing must not discard the chains after it; the cache keeps
      // completed lookups so a rerun resumes cheaply.
      failed.push(chain)
      console.error(`[${chain}] Failed: ${(error as Error).message}`)
    }
  }

  console.log(
    `\nScanned ${scanned} tokens, flagged ${flagged}, ${unknown} without a transfer tax result.`
  )
  if (failed.length > 0) {
    console.error(`Incomplete for: ${failed.join(', ')} — rerun to finish.`)
    process.exitCode = 1
  }
  if (!write) {
    console.log('Dry run — pass --write to apply changes.')
  }
}

main().catch(error => {
  console.error('Failed to sync fee-on-transfer flags:', error)
  process.exitCode = 1
})
