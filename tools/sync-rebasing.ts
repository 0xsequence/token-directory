import path from 'node:path'
import { promises as fs } from 'node:fs'
import { parseArgs } from 'node:util'
import { createPublicClient, http, parseAbi } from 'viem'
import type { PublicClient } from 'viem'

const TOKEN_DIRECTORY_ROOT = path.resolve('./index')

// Cached probe results keyed `chainId:address`, so an interrupted scan resumes
// without re-querying. A token's balance mechanism does not change once deployed.
const CACHE_PATH = path.resolve('./tools/.rebasing-cache.json')

// Deployed on every chain below at the same address.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

const PROBE_TARGET = '0x0000000000000000000000000000000000000000' as const

// One multicall carries CHUNK_SIZE * PROBES.length staticcalls; keep the batch
// under public-RPC response limits.
const CHUNK_SIZE = 10

// Public RPCs drop calls from an oversized batch and report them as reverts,
// which would read as "not rebasing". Each token therefore carries a sentinel
// call every ERC-20 answers; if it fails the whole result is discarded and the
// token is retried alone before being reported as unreachable.
const MAX_RETRIES = 3

// Public RPCs throttle sustained batch traffic; pacing requests keeps a large
// chain (mainnet carries ~2000 tokens) from tripping the limiter mid-scan.
const BATCH_DELAY_MS = 250

// Later retry rounds wait longer, giving a tripped rate limiter time to reset.
const RETRY_BACKOFF_MS = 5000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Chain folder name -> public RPC. Chains without an entry are skipped, so a
// rebasing token on an unlisted chain stays unflagged rather than mis-flagged.
const CHAIN_RPCS: Record<string, string> = {
  mainnet: 'https://ethereum-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  avalanche: 'https://avalanche-c-chain-rpc.publicnode.com',
  bnb: 'https://bsc-rpc.publicnode.com',
  gnosis: 'https://gnosis-rpc.publicnode.com',
  berachain: 'https://rpc.berachain.com',
  sonic: 'https://sonic-rpc.publicnode.com',
  soneium: 'https://rpc.soneium.org',
  katana: 'https://rpc.katana.network',
  hyperevm: 'https://rpc.hyperliquid.xyz/evm',
  'polygon-zkevm': 'https://zkevm-rpc.com',
  'arbitrum-nova': 'https://arbitrum-nova-rpc.publicnode.com',
  'base-sepolia': 'https://base-sepolia-rpc.publicnode.com',
  'arbitrum-sepolia': 'https://arbitrum-sepolia-rpc.publicnode.com',
  'optimism-sepolia': 'https://optimism-sepolia-rpc.publicnode.com',
  sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
  amoy: 'https://polygon-amoy-bor-rpc.publicnode.com',
  'avalanche-testnet': 'https://avalanche-fuji-c-chain-rpc.publicnode.com',
  'bnb-testnet': 'https://bsc-testnet-rpc.publicnode.com',
}

const NATIVE_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
])

const PROBE_ABI = parseAbi([
  // Sentinel: proves the staticcall reached the contract at all
  'function totalSupply() view returns (uint256)',
  // Aave v2/v3 aToken
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function scaledBalanceOf(address) view returns (uint256)',
  'function scaledTotalSupply() view returns (uint256)',
  // Aave v1 aToken
  'function underlyingAssetAddress() view returns (address)',
  'function principalBalanceOf(address) view returns (uint256)',
  // Lido stETH
  'function getPooledEthByShares(uint256) view returns (uint256)',
  'function sharesOf(address) view returns (uint256)',
  // Origin OUSD / OETH / superOETHb
  'function rebasingCreditsPerToken() view returns (uint256)',
  'function nonRebasingSupply() view returns (uint256)',
  // Mountain USDM and other reward-multiplier rebasers
  'function rewardMultiplier() view returns (uint256)',
  'function convertToShares(uint256) view returns (uint256)',
  // ERC4626 marker, used only to exclude share-price vaults
  'function asset() view returns (address)',
])

type ProbeName =
  | 'totalSupply'
  | 'underlyingAssetAddressUpper'
  | 'scaledBalanceOf'
  | 'scaledTotalSupply'
  | 'underlyingAssetAddressLower'
  | 'principalBalanceOf'
  | 'getPooledEthByShares'
  | 'sharesOf'
  | 'rebasingCreditsPerToken'
  | 'nonRebasingSupply'
  | 'rewardMultiplier'
  | 'convertToShares'
  | 'asset'

type Probe = {
  name: ProbeName
  functionName: string
  args: readonly unknown[]
}

const PROBES: readonly Probe[] = [
  { name: 'totalSupply', functionName: 'totalSupply', args: [] },
  {
    name: 'underlyingAssetAddressUpper',
    functionName: 'UNDERLYING_ASSET_ADDRESS',
    args: [],
  },
  {
    name: 'scaledBalanceOf',
    functionName: 'scaledBalanceOf',
    args: [PROBE_TARGET],
  },
  { name: 'scaledTotalSupply', functionName: 'scaledTotalSupply', args: [] },
  {
    name: 'underlyingAssetAddressLower',
    functionName: 'underlyingAssetAddress',
    args: [],
  },
  {
    name: 'principalBalanceOf',
    functionName: 'principalBalanceOf',
    args: [PROBE_TARGET],
  },
  {
    name: 'getPooledEthByShares',
    functionName: 'getPooledEthByShares',
    args: [1000000000000000000n],
  },
  { name: 'sharesOf', functionName: 'sharesOf', args: [PROBE_TARGET] },
  {
    name: 'rebasingCreditsPerToken',
    functionName: 'rebasingCreditsPerToken',
    args: [],
  },
  { name: 'nonRebasingSupply', functionName: 'nonRebasingSupply', args: [] },
  { name: 'rewardMultiplier', functionName: 'rewardMultiplier', args: [] },
  {
    name: 'convertToShares',
    functionName: 'convertToShares',
    args: [1000000000000000000n],
  },
  { name: 'asset', functionName: 'asset', args: [] },
]

type ProbeResult = Record<ProbeName, boolean>

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

type CacheEntry = { mechanism: string | null }

type ChainStats = {
  flagged: number
  cleared: number
  scanned: number
  unreachable: number
}

/**
 * Classify a token from which read-only selectors it answers. Each pair is a
 * signature no plain ERC-20 implements, so a hit means balances move without a
 * Transfer event. Returns null for tokens with fixed balances.
 */
function classify(probe: ProbeResult): string | null {
  // Aave v2/v3 aTokens: balance = scaledBalance * liquidity index.
  if (probe.underlyingAssetAddressUpper && probe.scaledBalanceOf) {
    return 'aave-atoken'
  }
  // Aave v1 aTokens predate the scaled-balance interface.
  if (probe.underlyingAssetAddressLower && probe.principalBalanceOf) {
    return 'aave-v1-atoken'
  }
  // Lido stETH: balance = shares * pooled ETH / total shares.
  if (probe.getPooledEthByShares && probe.sharesOf) {
    return 'lido-steth'
  }
  // Origin OUSD/OETH: balance = credits / creditsPerToken.
  if (probe.rebasingCreditsPerToken && probe.nonRebasingSupply) {
    return 'origin-rebasing'
  }
  // Ampleforth UFragments: balance = gons / gonsPerFragment. The Aave check runs
  // first, so an aToken never lands here.
  if (probe.scaledBalanceOf && probe.scaledTotalSupply) {
    return 'ampleforth'
  }
  // Mountain USDM: balance = shares * rewardMultiplier, scaled to 1e18. Meme
  // tokens expose an unscaled rewardMultiplier that means something else, so
  // require the shares accessor too. ERC-4626 vaults move share price instead
  // of balances, so exclude anything exposing asset().
  if (probe.rewardMultiplier && probe.convertToShares && !probe.asset) {
    return 'reward-multiplier'
  }
  return null
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
  // Written after every chunk, so a kill mid-write must not truncate the file.
  const tmp = `${CACHE_PATH}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`)
  await fs.rename(tmp, CACHE_PATH)
}

/**
 * Probe a chunk of tokens in one multicall. Returns null for a token whose
 * sentinel call failed, so an RPC fault never looks like "not rebasing".
 */
async function probeChunk(
  client: PublicClient,
  addresses: readonly string[]
): Promise<(ProbeResult | null)[]> {
  const contracts = addresses.flatMap(address =>
    PROBES.map(probe => ({
      address: address as `0x${string}`,
      abi: PROBE_ABI,
      functionName: probe.functionName,
      args: probe.args,
    }))
  )

  const results = await client.multicall({
    contracts,
    allowFailure: true,
    multicallAddress: MULTICALL3,
  })

  return addresses.map((_, tokenIndex) => {
    const slice = results.slice(
      tokenIndex * PROBES.length,
      (tokenIndex + 1) * PROBES.length
    )

    // Multicall3 returns a failure both for a reverted staticcall and for a
    // selector the contract does not implement; either way the probe is absent.
    const probe = {} as ProbeResult
    PROBES.forEach((definition, index) => {
      probe[definition.name] = slice[index].status === 'success'
    })

    // A token that cannot answer totalSupply did not really get called: public
    // RPCs silently drop calls from a large batch and report them as reverts.
    // Treating that as "no rebase selectors" would unflag real rebasing tokens.
    return probe.totalSupply ? probe : null
  })
}

/**
 * Probe one token with individual eth_calls. Pre-EIP-140 contracts answer an
 * unknown selector with `throw`, which consumes the entire gas allowance and
 * fails every later call in the same multicall; a per-call request bounds that
 * blast radius to the one probe.
 */
async function probeSingle(
  client: PublicClient,
  address: string
): Promise<ProbeResult | null> {
  const probe = {} as ProbeResult

  for (const definition of PROBES) {
    try {
      await client.readContract({
        address: address as `0x${string}`,
        abi: PROBE_ABI,
        functionName: definition.functionName,
        args: definition.args,
      })
      probe[definition.name] = true
    } catch {
      probe[definition.name] = false
    }
  }

  return probe.totalSupply ? probe : null
}

/**
 * Probe tokens, retrying anything whose sentinel failed in progressively
 * smaller batches, then one eth_call at a time. Tokens still failing are
 * returned as null.
 */
async function probeWithRetry(
  client: PublicClient,
  tokens: readonly TokenListEntry[]
): Promise<Map<string, ProbeResult | null>> {
  const resolved = new Map<string, ProbeResult | null>()
  let pending = [...tokens]

  for (
    let attempt = 0;
    attempt < MAX_RETRIES && pending.length > 0;
    attempt++
  ) {
    const stillPending: TokenListEntry[] = []

    // Let a rate limiter that tripped during the previous round reset.
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS * attempt)

    // The last round abandons multicall entirely; a gas-guzzling revert in one
    // token can no longer take its neighbours down with it.
    if (attempt === MAX_RETRIES - 1) {
      for (const token of pending) {
        try {
          const probe = await probeSingle(client, token.address)
          if (probe === null) {
            stillPending.push(token)
            continue
          }
          resolved.set(token.address.toLowerCase(), probe)
        } catch {
          stillPending.push(token)
        }
      }
      pending = stillPending
      break
    }

    const size =
      attempt === 0 ? CHUNK_SIZE : Math.max(1, CHUNK_SIZE >> (attempt * 2))

    for (let start = 0; start < pending.length; start += size) {
      const batch = pending.slice(start, start + size)
      if (start > 0) await sleep(BATCH_DELAY_MS)
      let probes: (ProbeResult | null)[]
      try {
        probes = await probeChunk(
          client,
          batch.map(token => token.address)
        )
      } catch {
        // A transport-level failure is retryable in the same way a dropped
        // call is; fall through to the next, smaller round.
        stillPending.push(...batch)
        continue
      }

      batch.forEach((token, index) => {
        const probe = probes[index]
        if (probe === null) {
          stillPending.push(token)
          return
        }
        resolved.set(token.address.toLowerCase(), probe)
      })
    }

    pending = stillPending
  }

  // Anything unresolved is reported rather than silently treated as clean.
  for (const token of pending) {
    resolved.set(token.address.toLowerCase(), null)
  }

  return resolved
}

async function processChain(
  chain: string,
  write: boolean,
  cache: Record<string, CacheEntry>
): Promise<ChainStats> {
  const rpcUrl = CHAIN_RPCS[chain]
  const tokenListPath = path.join(TOKEN_DIRECTORY_ROOT, chain, 'erc20.json')

  let tokenList: TokenList
  try {
    tokenList = JSON.parse(
      await fs.readFile(tokenListPath, 'utf-8')
    ) as TokenList
  } catch {
    console.warn(`[${chain}] No erc20.json found, skipping.`)
    return { flagged: 0, cleared: 0, scanned: 0, unreachable: 0 }
  }

  const candidates = tokenList.tokens.filter(
    token => !NATIVE_ADDRESSES.has(token.address.toLowerCase())
  )

  const client: PublicClient = createPublicClient({ transport: http(rpcUrl) })

  console.log(`[${chain}] Probing ${candidates.length} tokens...`)

  let flagged = 0
  let cleared = 0
  let unreachable = 0
  let dirty = false

  const uncached = candidates.filter(
    token => !(`${token.chainId}:${token.address.toLowerCase()}` in cache)
  )

  if (uncached.length > 0) {
    const probes = await probeWithRetry(client, uncached)
    for (const token of uncached) {
      const probe = probes.get(token.address.toLowerCase())
      // An unresolved probe is left out of the cache so a rerun retries it.
      if (probe === null || probe === undefined) continue
      cache[`${token.chainId}:${token.address.toLowerCase()}`] = {
        mechanism: classify(probe),
      }
    }
    await saveCache(cache)
  }

  for (const token of candidates) {
    const entry = cache[`${token.chainId}:${token.address.toLowerCase()}`]
    if (!entry) {
      unreachable++
      console.warn(
        `  [${chain}] ${token.symbol ?? token.name} (${token.address}) unreachable`
      )
      continue
    }

    const isRebasing = entry.mechanism !== null
    const wasFlagged = token.extensions?.rebasing === true

    if (isRebasing && !wasFlagged) {
      flagged++
      dirty = true
      console.log(
        `  [${chain}] ${token.symbol ?? token.name} (${token.address}) ${entry.mechanism}`
      )
      token.extensions = { ...token.extensions, rebasing: true }
    } else if (!isRebasing && wasFlagged) {
      // A probe that came back clean contradicts the stored flag; drop it so
      // the field never outlives the evidence for it.
      cleared++
      dirty = true
      console.log(
        `  [${chain}] ${token.symbol ?? token.name} (${token.address}) no longer rebasing`
      )
      delete token.extensions?.rebasing
    }
  }

  console.log(
    `[${chain}] ${write ? 'Flagged' : 'Would flag'} ${flagged} tokens` +
      `${cleared > 0 ? `, cleared ${cleared}` : ''}` +
      `${unreachable > 0 ? `, ${unreachable} unreachable` : ''}.`
  )

  if (dirty && write) {
    await fs.writeFile(tokenListPath, `${JSON.stringify(tokenList, null, 2)}\n`)
    console.log(`[${chain}] Wrote ${tokenListPath}`)
  }

  return { flagged, cleared, scanned: candidates.length, unreachable }
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

  if (chainFilter && !CHAIN_RPCS[chainFilter]) {
    console.error(
      `Unknown chain "${chainFilter}". Supported: ${Object.keys(CHAIN_RPCS).join(', ')}`
    )
    process.exitCode = 1
    return
  }

  const chains = chainFilter ? [chainFilter] : Object.keys(CHAIN_RPCS)

  const cache = await loadCache()

  let flagged = 0
  let cleared = 0
  let scanned = 0
  let unreachable = 0
  const failed: string[] = []

  for (const chain of chains) {
    try {
      const result = await processChain(chain, write, cache)
      flagged += result.flagged
      cleared += result.cleared
      scanned += result.scanned
      unreachable += result.unreachable
    } catch (error) {
      // One chain failing must not discard the chains after it; the cache keeps
      // completed probes so a rerun resumes cheaply.
      failed.push(chain)
      console.error(`[${chain}] Failed: ${(error as Error).message}`)
    }
  }

  console.log(
    `\nProbed ${scanned} tokens, flagged ${flagged}, cleared ${cleared}` +
      `, ${unreachable} unreachable.`
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
  console.error('Failed to sync rebasing flags:', error)
  process.exitCode = 1
})
