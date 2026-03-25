import path from 'node:path'
import { promises as fs } from 'node:fs'

// ── Types ──────────────────────────────────────────────────────────────────

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
  version?: {
    major: number
    minor: number
    patch: number
  }
}

type TrailsPool = {
  id: string
  name: string
  protocol: string
  chainId: number
  token: {
    symbol: string
    name: string
    address: string
    decimals: number
    logoUrl: string
  }
  depositAddress: string
  isActive: boolean
}

type UnderlyingTokenInfo = {
  address: string
  name: string
  symbol: string
  decimals: number
}

type LookupResult<T> = {
  lookup: Map<string, T>
  issues: string[]
}

// ── Constants ──────────────────────────────────────────────────────────────

const TOKEN_DIRECTORY_ROOT = path.resolve('./index')
const MORPHO_ENDPOINT = 'https://api.morpho.org/graphql'
const AAVE_ENDPOINT = 'https://api.v3.aave.com/graphql'

const CHAIN_ID_TO_FOLDER: Record<number, string> = {
  1: 'mainnet',
  10: 'optimism',
  100: 'gnosis',
  137: 'polygon',
  42161: 'arbitrum',
  8453: 'base',
}

const CHAIN_NAME_MAP: Record<string, number> = {
  ethereum: 1,
  mainnet: 1,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
  optimism: 10,
  gnosis: 100,
}

// ── Helpers ────────────────────────────────────────────────────────────────

const loadTokenList = async (tokenListPath: string): Promise<TokenList> => {
  const raw = await fs.readFile(tokenListPath, 'utf-8')
  return JSON.parse(raw) as TokenList
}

const writeTokenList = async (tokenListPath: string, tokenList: TokenList) => {
  await fs.writeFile(tokenListPath, `${JSON.stringify(tokenList, null, 2)}\n`)
}

const addrKey = (chainId: number, address: string) =>
  `${chainId}:${address.toLowerCase()}`

async function gql<T>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(
      `GraphQL HTTP ${res.status} from ${endpoint}: ${await res.text()}`
    )
  }

  const json = (await res.json()) as {
    data?: T
    errors?: { message: string }[]
  }

  if (json.errors?.length) {
    throw new Error(
      `GraphQL error: ${json.errors.map(e => e.message).join('; ')}`
    )
  }

  if (!json.data) {
    throw new Error(`No data returned from ${endpoint}`)
  }

  return json.data
}

// ── Morpho API ─────────────────────────────────────────────────────────────

const MORPHO_V2_QUERY = /* GraphQL */ `
  query GetMorphoV2Vaults($first: Int!, $skip: Int!) {
    vaultV2s(
      first: $first
      skip: $skip
      orderBy: TotalAssetsUsd
      orderDirection: Desc
    ) {
      items {
        address
        asset {
          address
          symbol
          name
          decimals
        }
        chain {
          id
          network
        }
      }
    }
  }
`

const MORPHO_V1_QUERY = /* GraphQL */ `
  query GetMorphoV1Vaults($first: Int!, $skip: Int!) {
    vaults(
      first: $first
      skip: $skip
      orderBy: TotalAssetsUsd
      orderDirection: Desc
    ) {
      items {
        address
        asset {
          address
          symbol
          name
          decimals
        }
        chain {
          id
          network
        }
      }
    }
  }
`

type MorphoVaultItem = {
  address: string
  asset?: {
    address?: string
    symbol?: string
    name?: string
    decimals?: number
  }
  chain: { id?: number; network?: string }
}

function resolveChainId(chain: {
  id?: number
  network?: string
}): number | null {
  return (
    chain.id ??
    (chain.network
      ? (CHAIN_NAME_MAP[chain.network.trim().toLowerCase()] ?? null)
      : null)
  )
}

function resolveMorphoShareDecimals(assetDecimals?: number): number {
  if (assetDecimals === undefined) {
    throw new Error(
      'Morpho asset decimals are required to resolve share decimals'
    )
  }

  if (assetDecimals > 18) {
    throw new Error(
      `Morpho asset decimals ${assetDecimals} are unexpected for this sync`
    )
  }

  // MetaMorpho share tokens are 18 decimals for the <=18-decimal assets we
  // sync. If Morpho ever lists a vault backed by an asset with >18 decimals,
  // treat it as unexpected source data and skip it.
  return 18
}

async function fetchMorphoVaultLookup(
  query: string,
  dataKey: 'vaultV2s' | 'vaults'
): Promise<
  LookupResult<{ underlying: UnderlyingTokenInfo; vaultDecimals: number }>
> {
  const lookup = new Map<
    string,
    { underlying: UnderlyingTokenInfo; vaultDecimals: number }
  >()
  const issues: string[] = []
  const pageSize = 500
  let skip = 0

  while (true) {
    const data = await gql<Record<string, { items: MorphoVaultItem[] }>>(
      MORPHO_ENDPOINT,
      query,
      { first: pageSize, skip }
    )

    const items = data[dataKey].items
    if (!items.length) break

    for (const vault of items) {
      const chainId = resolveChainId(vault.chain)
      if (!chainId) continue

      const underlyingAddress = vault.asset?.address
      const underlyingDecimals = vault.asset?.decimals
      const missingFields = [
        !underlyingAddress ? 'asset.address' : null,
        underlyingDecimals === undefined ? 'asset.decimals' : null,
        underlyingDecimals !== undefined && underlyingDecimals > 18
          ? `asset.decimals=${underlyingDecimals} (unexpected)`
          : null,
      ]
        .filter(Boolean)
        .join(', ')

      if (missingFields) {
        issues.push(
          `[morpho ${dataKey}] chain=${chainId} vault=${vault.address} missing required fields: ${missingFields}`
        )
        continue
      }

      const key = addrKey(chainId, vault.address)
      if (!lookup.has(key)) {
        lookup.set(key, {
          underlying: {
            address: underlyingAddress,
            name: vault.asset?.name ?? '',
            symbol: vault.asset?.symbol ?? '',
            decimals: underlyingDecimals,
          },
          vaultDecimals: resolveMorphoShareDecimals(underlyingDecimals),
        })
      }
    }

    if (items.length < pageSize) break
    skip += pageSize
  }

  return { lookup, issues }
}

// ── Aave API ──────────────────────────────────────────────────────────────

const AAVE_MARKETS_QUERY = /* GraphQL */ `
  query Markets($request: MarketsRequest!) {
    markets(request: $request) {
      chain {
        chainId
      }
      reserves {
        aToken {
          address
          chainId
        }
        underlyingToken {
          address
          name
          symbol
          decimals
        }
      }
    }
  }
`

type AaveMarket = {
  chain?: { chainId: number }
  reserves?: {
    aToken: { address: string; chainId: number }
    underlyingToken?: {
      address?: string
      name?: string
      symbol?: string
      decimals?: number
    } | null
  }[]
}

async function fetchAaveLookup(): Promise<LookupResult<UnderlyingTokenInfo>> {
  const lookup = new Map<string, UnderlyingTokenInfo>()
  const issues: string[] = []
  const chainIds = Object.keys(CHAIN_ID_TO_FOLDER).map(Number)

  const data = await gql<{ markets?: AaveMarket[] }>(
    AAVE_ENDPOINT,
    AAVE_MARKETS_QUERY,
    { request: { chainIds } }
  )

  for (const market of data.markets ?? []) {
    for (const reserve of market.reserves ?? []) {
      const ut = reserve.underlyingToken

      const chainId = reserve.aToken.chainId ?? market.chain?.chainId
      if (!chainId) continue

      const missingFields = [
        !ut?.address ? 'underlyingToken.address' : null,
        ut?.decimals === undefined ? 'underlyingToken.decimals' : null,
      ]
        .filter(Boolean)
        .join(', ')

      if (missingFields) {
        issues.push(
          `[aave] chain=${chainId} aToken=${reserve.aToken.address} missing required fields: ${missingFields}`
        )
        continue
      }

      const key = addrKey(chainId, reserve.aToken.address)
      if (!lookup.has(key)) {
        lookup.set(key, {
          address: ut.address,
          name: ut.name ?? '',
          symbol: ut.symbol ?? '',
          decimals: ut.decimals,
        })
      }
    }
  }

  return { lookup, issues }
}

// ── Enrichment ─────────────────────────────────────────────────────────────

function enrichToken(
  token: TokenListEntry,
  underlying?: UnderlyingTokenInfo,
  vaultDecimals?: number
): boolean {
  if (!token.extensions) token.extensions = {}
  let changed = false

  if (vaultDecimals !== undefined && token.decimals !== vaultDecimals) {
    token.decimals = vaultDecimals
    changed = true
  }

  if (!underlying) return changed

  const fields: [string, unknown][] = [
    ['underlyingTokenAddress', underlying.address],
    ['underlyingTokenName', underlying.name],
    ['underlyingTokenSymbol', underlying.symbol],
    ['underlyingTokenDecimals', underlying.decimals],
  ]

  for (const [key, value] of fields) {
    if (token.extensions[key] === undefined) {
      token.extensions[key] = value
      changed = true
    }
  }

  return changed
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let added = 0
  let enriched = 0
  let omitted = 0
  let skipped = 0
  const issues = new Set<string>()

  // Step 1: Load chain token lists
  console.log('Loading chain token lists...')
  const chainTokenLists = new Map<number, { path: string; list: TokenList }>()
  for (const [chainIdStr, folder] of Object.entries(CHAIN_ID_TO_FOLDER)) {
    const chainId = Number(chainIdStr)
    const tokenListPath = path.join(TOKEN_DIRECTORY_ROOT, folder, 'erc20.json')
    try {
      const list = await loadTokenList(tokenListPath)
      chainTokenLists.set(chainId, { path: tokenListPath, list })
      console.log(`  [${folder}] Loaded ${list.tokens.length} tokens`)
    } catch {
      console.warn(`  [${folder}] Failed to load, skipping`)
    }
  }

  // Build address lookup of ALL existing tokens
  const existingAddresses = new Set<string>()
  const tokenByAddress = new Map<string, TokenListEntry>()
  for (const [chainId, { list }] of chainTokenLists) {
    for (const token of list.tokens) {
      const key = addrKey(chainId, token.address)
      existingAddresses.add(key)
      tokenByAddress.set(key, token)
    }
  }

  // Step 2: Fetch underlying token lookups from Morpho and Aave
  console.log('\nFetching underlying token data from APIs...')

  const [morphoV2Result, morphoV1Result, aaveResult] = await Promise.all([
    fetchMorphoVaultLookup(MORPHO_V2_QUERY, 'vaultV2s').then(result => {
      console.log(
        `  Morpho V2: ${result.lookup.size} vaults${result.issues.length ? ` (${result.issues.length} omitted)` : ''}`
      )
      return result
    }),
    fetchMorphoVaultLookup(MORPHO_V1_QUERY, 'vaults').then(result => {
      console.log(
        `  Morpho V1: ${result.lookup.size} vaults${result.issues.length ? ` (${result.issues.length} omitted)` : ''}`
      )
      return result
    }),
    fetchAaveLookup().then(result => {
      console.log(
        `  Aave: ${result.lookup.size} reserves${result.issues.length ? ` (${result.issues.length} omitted)` : ''}`
      )
      return result
    }),
  ])

  for (const issue of [
    ...morphoV2Result.issues,
    ...morphoV1Result.issues,
    ...aaveResult.issues,
  ]) {
    issues.add(issue)
  }

  const morphoV2Lookup = morphoV2Result.lookup
  const morphoV1Lookup = morphoV1Result.lookup
  const aaveLookup = aaveResult.lookup

  // Step 3: Load trails pools
  // TODO: Replace with trails API endpoint when available
  console.log('\nLoading trails earn pools data...')
  const poolsPath = path.join(
    TOKEN_DIRECTORY_ROOT,
    'trails-earn-pools-data.json'
  )
  let pools: TrailsPool[] = []
  try {
    const raw = await fs.readFile(poolsPath, 'utf-8')
    pools = JSON.parse(raw) as TrailsPool[]
    console.log(`Loaded ${pools.length} trails pools`)
  } catch {
    console.warn('No pools.json found, nothing to do')
    return
  }

  // Step 4: Process pools — add new tokens and enrich with underlying data
  console.log('\n── Processing trails pools ──')
  for (const pool of pools) {
    const folder = CHAIN_ID_TO_FOLDER[pool.chainId]
    if (!folder) continue

    const chainData = chainTokenLists.get(pool.chainId)
    if (!chainData) continue

    const depositKey = addrKey(pool.chainId, pool.depositAddress)
    const protocol = pool.protocol.toLowerCase()

    // Look up underlying token data from the appropriate API
    const morphoMatch =
      morphoV2Lookup.get(depositKey) ?? morphoV1Lookup.get(depositKey)
    const aaveMatch = aaveLookup.get(depositKey)
    const underlying =
      protocol === 'morpho'
        ? morphoMatch?.underlying
        : protocol === 'aave'
          ? aaveMatch
          : undefined
    const vaultDecimals =
      protocol === 'morpho' ? morphoMatch?.vaultDecimals : undefined

    if (protocol === 'morpho' && !morphoMatch) {
      issues.add(
        `[${folder}] ${pool.name} (${pool.depositAddress}) missing Morpho metadata; token omitted or enrichment skipped`
      )
    }

    if (protocol === 'aave' && !aaveMatch) {
      issues.add(
        `[${folder}] ${pool.name} (${pool.depositAddress}) missing Aave metadata; token omitted or enrichment skipped`
      )
    }

    // If token already exists, try to enrich it
    if (existingAddresses.has(depositKey)) {
      const existing = tokenByAddress.get(depositKey)

      if (existing && (underlying || vaultDecimals !== undefined)) {
        if (enrichToken(existing, underlying, vaultDecimals)) {
          enriched++
          console.log(`  [${folder}] Enriched: ${existing.name}`)
        }
      }
      skipped++
      continue
    }

    if (
      (protocol === 'morpho' && !morphoMatch) ||
      (protocol === 'aave' && !aaveMatch)
    ) {
      omitted++
      continue
    }

    // Build extensions with underlying data if available
    const extensions: Record<string, unknown> = {
      protocol,
      ...(underlying
        ? {
            underlyingTokenAddress: underlying.address,
            underlyingTokenName: underlying.name,
            underlyingTokenSymbol: underlying.symbol,
            underlyingTokenDecimals: underlying.decimals,
          }
        : {}),
      ...(protocol === 'aave' ? { aaveAToken: true } : {}),
      indexingInfo: { useOnChainBalance: true },
    }

    const decimals =
      protocol === 'morpho' ? vaultDecimals! : pool.token.decimals

    // Add new token
    const newToken: TokenListEntry = {
      chainId: pool.chainId,
      address: pool.depositAddress,
      name: pool.name,
      symbol: pool.token.symbol,
      decimals,
      logoURI: pool.token.logoUrl ?? '',
      extensions,
    }

    chainData.list.tokens.push(newToken)
    existingAddresses.add(depositKey)
    tokenByAddress.set(depositKey, newToken)
    added++
    console.log(`  [${folder}] Added: ${pool.name} (${pool.depositAddress})`)
  }

  // Step 5: Write updated files (if changes were made)
  if (added > 0 || enriched > 0) {
    console.log('\n── Writing updated token lists ──')
    for (const [chainId, { path: tokenListPath, list }] of chainTokenLists) {
      const folder = CHAIN_ID_TO_FOLDER[chainId]
      await writeTokenList(tokenListPath, list)
      console.log(`  [${folder}] Written ${list.tokens.length} tokens`)
    }
  }

  console.log(`\n── Done ──`)
  console.log(`  ${added} trails tokens added`)
  console.log(`  ${enriched} existing tokens enriched with underlying data`)
  console.log(`  ${omitted} tokens omitted due to missing required data`)
  console.log(`  ${skipped} deduped (already exist from aave/morpho syncs)`)

  if (issues.size) {
    console.warn('\n── Issues ──')
    for (const issue of issues) {
      console.warn(`  ${issue}`)
    }
  }
}

main().catch(error => {
  console.error('Failed:', error)
  process.exitCode = 1
})
