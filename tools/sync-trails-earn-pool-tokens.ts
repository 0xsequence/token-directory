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

// ── Constants ──────────────────────────────────────────────────────────────

const TOKEN_DIRECTORY_ROOT = path.resolve('./index')

const CHAIN_ID_TO_FOLDER: Record<number, string> = {
  1: 'mainnet',
  10: 'optimism',
  100: 'gnosis',
  137: 'polygon',
  42161: 'arbitrum',
  8453: 'base',
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

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let added = 0
  let skipped = 0

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

  // Build address lookup of ALL existing tokens (including aave + morpho already added)
  const existingAddresses = new Set<string>()
  for (const [chainId, { list }] of chainTokenLists) {
    for (const token of list.tokens) {
      existingAddresses.add(addrKey(chainId, token.address))
    }
  }

  // Step 2: Load trails pools
  // TODO: Replace with trails API endpoint when available
  console.log('\nLoading trails earn pools data...')
  const poolsPath = path.join(TOKEN_DIRECTORY_ROOT, 'trails-earn-pools-data.json')
  let pools: TrailsPool[] = []
  try {
    const raw = await fs.readFile(poolsPath, 'utf-8')
    pools = JSON.parse(raw) as TrailsPool[]
    console.log(`Loaded ${pools.length} trails pools`)
  } catch {
    console.warn('No pools.json found, nothing to do')
    return
  }

  // Step 3: Process pools — only add tokens not already in directory
  console.log('\n── Processing trails pools ──')
  for (const pool of pools) {
    const folder = CHAIN_ID_TO_FOLDER[pool.chainId]
    if (!folder) continue

    const chainData = chainTokenLists.get(pool.chainId)
    if (!chainData) continue

    const depositKey = addrKey(pool.chainId, pool.depositAddress)

    // Skip if already exists (added by sync-aave-tokens or sync-morpho-tokens)
    if (existingAddresses.has(depositKey)) {
      skipped++
      continue
    }

    // Add new token
    const newToken: TokenListEntry = {
      chainId: pool.chainId,
      address: pool.depositAddress,
      name: pool.name,
      symbol: pool.token.symbol,
      decimals: pool.token.decimals,
      logoURI: pool.token.logoUrl ?? '',
      extensions: {
        protocol: pool.protocol.toLowerCase(),
        indexingInfo: { useOnChainBalance: true },
      },
    }

    chainData.list.tokens.push(newToken)
    existingAddresses.add(depositKey)
    added++
    console.log(
      `  [${folder}] Added: ${pool.name} (${pool.depositAddress})`
    )
  }

  // Step 4: Write updated files (only if changes were made)
  if (added > 0) {
    console.log('\n── Writing updated token lists ──')
    for (const [chainId, { path: tokenListPath, list }] of chainTokenLists) {
      const folder = CHAIN_ID_TO_FOLDER[chainId]
      await writeTokenList(tokenListPath, list)
      console.log(`  [${folder}] Written ${list.tokens.length} tokens`)
    }
  }

  console.log(`\n── Done ──`)
  console.log(`  ${added} trails tokens added`)
  console.log(`  ${skipped} deduped (already exist from aave/morpho syncs)`)
}

main().catch(error => {
  console.error('Failed:', error)
  process.exitCode = 1
})
