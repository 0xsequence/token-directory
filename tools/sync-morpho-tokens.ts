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

type MorphoVault = {
  address: string
  symbol?: string
  name?: string
  totalAssetsUsd?: number
  asset?: {
    address?: string
    symbol?: string
    name?: string
    decimals?: number
  }
  chain: {
    id?: number
    network?: string
  }
}

// ── Constants ──────────────────────────────────────────────────────────────

const TOKEN_DIRECTORY_ROOT = path.resolve('./index')
const MORPHO_ENDPOINT = 'https://api.morpho.org/graphql'

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

// ── Filter configuration ───────────────────────────────────────────────────

const MAX_VAULTS_PER_CHAIN = 20

// Major assets (matched case-insensitively by symbol)
const MAJOR_ASSET_SYMBOLS = new Set([
  'usdc',
  'usdt',
  'usdt0',
  'weth',
  'eth',
  'wpol',
  'pol',
  'dai',
  'wbtc',
])

// ── GraphQL ────────────────────────────────────────────────────────────────

const MORPHO_QUERY = /* GraphQL */ `
  query GetMorphoVaults($first: Int!, $skip: Int!) {
    vaultV2s(
      first: $first
      skip: $skip
      orderBy: TotalAssetsUsd
      orderDirection: Desc
    ) {
      items {
        address
        symbol
        name
        totalAssetsUsd
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

function resolveMorphoShareDecimals(assetDecimals?: number): number | null {
  if (assetDecimals === undefined) return null

  if (assetDecimals > 18) return null

  // MetaMorpho share tokens are 18 decimals for the <=18-decimal assets we
  // sync. If Morpho ever lists a vault backed by an asset with >18 decimals,
  // treat it as unexpected source data and skip it.
  return 18
}

const ensureExtension = (
  token: TokenListEntry,
  key: string,
  value: unknown
) => {
  if (!token.extensions) token.extensions = {}
  if (token.extensions[key] === undefined) {
    token.extensions[key] = value
  }
}

const ensureIndexingInfo = (token: TokenListEntry) => {
  if (!token.extensions) token.extensions = {}
  if (!token.extensions.indexingInfo) {
    token.extensions.indexingInfo = { useOnChainBalance: true }
  } else {
    const info = token.extensions.indexingInfo as Record<string, unknown>
    if (info.useOnChainBalance === undefined) {
      info.useOnChainBalance = true
    }
  }
}

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

function normalizeChainName(input: string): number | null {
  return CHAIN_NAME_MAP[input.trim().toLowerCase()] ?? null
}

async function fetchMorphoVaults(): Promise<MorphoVault[]> {
  const pageSize = 500
  let skip = 0
  const all: MorphoVault[] = []

  // Fetch pages sorted by TVL desc until we have enough per chain
  while (true) {
    const data = await gql<{
      vaultV2s: { items: MorphoVault[] }
    }>(MORPHO_ENDPOINT, MORPHO_QUERY, {
      first: pageSize,
      skip,
    })

    const items = data.vaultV2s.items
    if (!items.length) break

    all.push(...items)

    // Stop once TVL drops below a reasonable floor (no point paginating tiny vaults)
    const lastTvl = items[items.length - 1].totalAssetsUsd ?? 0
    if (lastTvl < 100_000) break
    if (items.length < pageSize) break
    skip += pageSize
  }

  return all
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let added = 0
  let modified = 0
  let omitted = 0
  const issues: string[] = []

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

  // Build address lookup
  const tokenByAddress = new Map<string, TokenListEntry>()
  for (const [chainId, { list }] of chainTokenLists) {
    for (const token of list.tokens) {
      tokenByAddress.set(addrKey(chainId, token.address), token)
    }
  }

  // Step 2: Fetch Morpho vaults (sorted by TVL desc)
  console.log('\nFetching Morpho vaults...')
  const allVaults = await fetchMorphoVaults()
  console.log(`Fetched ${allVaults.length} vaults`)

  // Step 3: Filter to major assets only
  console.log('\n── Filtering to major assets ──')
  const passed: (MorphoVault & { chainId: number })[] = []

  for (const vault of allVaults) {
    const chainId =
      vault.chain.id ??
      (vault.chain.network ? normalizeChainName(vault.chain.network) : null)
    if (!chainId || !CHAIN_ID_TO_FOLDER[chainId]) continue

    const assetSymbol = (vault.asset?.symbol ?? '').toLowerCase()
    if (!MAJOR_ASSET_SYMBOLS.has(assetSymbol)) continue

    // Skip empty/test vaults
    if ((vault.totalAssetsUsd ?? 0) < 100_000) continue
    if (!vault.name?.trim()) continue

    passed.push({ ...vault, chainId })
  }

  console.log(`  ${passed.length} vaults with major assets`)

  // Step 4: Group by chain, sort by TVL, take top N per chain
  const byChain = new Map<number, (MorphoVault & { chainId: number })[]>()
  for (const vault of passed) {
    const group = byChain.get(vault.chainId) ?? []
    group.push(vault)
    byChain.set(vault.chainId, group)
  }

  const selected: (MorphoVault & { chainId: number })[] = []
  for (const [chainId, vaults] of byChain) {
    const folder = CHAIN_ID_TO_FOLDER[chainId]
    vaults.sort((a, b) => (b.totalAssetsUsd ?? 0) - (a.totalAssetsUsd ?? 0))
    const top = vaults.slice(0, MAX_VAULTS_PER_CHAIN)
    selected.push(...top)

    console.log(`\n  [${folder}] Top ${top.length} vaults:`)
    for (const v of top) {
      const tvl = ((v.totalAssetsUsd ?? 0) / 1e6).toFixed(1)
      console.log(`    ${v.name} | ${v.asset?.symbol} | TVL: $${tvl}M`)
    }
  }

  console.log(`\n  Total selected: ${selected.length} vaults`)

  // Step 5: Add/update tokens
  console.log('\n── Updating token lists ──')
  for (const vault of selected) {
    const folder = CHAIN_ID_TO_FOLDER[vault.chainId]
    const chainData = chainTokenLists.get(vault.chainId)
    if (!chainData) continue

    const key = addrKey(vault.chainId, vault.address)
    const existing = tokenByAddress.get(key)
    const underlyingAddress = vault.asset?.address
    const underlyingDecimals = vault.asset?.decimals
    const shareDecimals = resolveMorphoShareDecimals(underlyingDecimals)

    if (!underlyingAddress || shareDecimals === null) {
      const missingFields = [
        !underlyingAddress ? 'asset.address' : null,
        underlyingDecimals === undefined ? 'asset.decimals' : null,
        underlyingDecimals !== undefined && underlyingDecimals > 18
          ? `asset.decimals=${underlyingDecimals} (unexpected)`
          : null,
      ]
        .filter(Boolean)
        .join(', ')

      omitted++
      issues.push(
        `[${folder}] ${vault.name ?? vault.address} (${vault.address}) missing required Morpho fields: ${missingFields}`
      )
      continue
    }

    if (existing) {
      let changed = false
      if (!existing.extensions?.protocol) {
        ensureExtension(existing, 'protocol', 'morpho')
        changed = true
      }
      if (
        !(existing.extensions?.indexingInfo as Record<string, unknown>)
          ?.useOnChainBalance
      ) {
        ensureIndexingInfo(existing)
        changed = true
      }
      if (existing.decimals !== shareDecimals) {
        existing.decimals = shareDecimals
        changed = true
      }
      if (changed) {
        modified++
        console.log(`  [${folder}] Updated: ${existing.name}`)
      }
    } else {
      const newToken: TokenListEntry = {
        chainId: vault.chainId,
        address: vault.address,
        name: vault.name ?? vault.symbol ?? vault.address,
        symbol: vault.symbol ?? vault.address,
        decimals: shareDecimals,
        logoURI: '',
        extensions: {
          protocol: 'morpho',
          underlyingTokenAddress: underlyingAddress,
          underlyingTokenName: vault.asset?.name ?? '',
          underlyingTokenSymbol: vault.asset?.symbol ?? '',
          underlyingTokenDecimals: underlyingDecimals,
          indexingInfo: { useOnChainBalance: true },
        },
      }

      chainData.list.tokens.push(newToken)
      tokenByAddress.set(key, newToken)
      added++
      console.log(`  [${folder}] Added: ${newToken.name} (${vault.address})`)
    }
  }

  // Step 6: Write updated files
  console.log('\n── Writing updated token lists ──')
  for (const [chainId, { path: tokenListPath, list }] of chainTokenLists) {
    const folder = CHAIN_ID_TO_FOLDER[chainId]
    await writeTokenList(tokenListPath, list)
    console.log(`  [${folder}] Written ${list.tokens.length} tokens`)
  }

  console.log(`\n── Done ──`)
  console.log(`  ${added} Morpho vaults added`)
  console.log(`  ${modified} existing tokens updated`)
  console.log(`  ${omitted} vaults omitted due to missing required data`)

  if (issues.length) {
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
