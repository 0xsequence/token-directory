import path from 'node:path'
import { promises as fs } from 'node:fs'

export const GET_ALL_AAVE_MARKETS = `query Markets($request: MarketsRequest!) {
  markets(request: $request) {
    chain {
      name
      chainId
    }
    name
    reserves {
      aToken {
        imageUrl
        decimals
        chainId
        address
        name
        symbol
      }
      underlyingToken {
        address
        name
        symbol
        imageUrl
        decimals
      }
    }
  }
}`

const endpointUrl = 'https://api.v3.aave.com/graphql'
const TOKEN_DIRECTORY_ROOT = path.resolve('./index')
const TARGET_CHAIN_IDS: number[] = [
  1, 42161, 43114, 8453, 56, 100, 10, 137, 84532,
]

// Aave V2 subgraph IDs on The Graph decentralized network
// Requires THEGRAPH_API_KEY environment variable
// Get a free API key (100k queries/month) at https://thegraph.com/studio/apikeys/
const V2_SUBGRAPH_IDS: Record<number, string> = {
  1: '8wR23o1zkS4gpLqLNU4kG3JHYVucqGyopL5utGxP2q1N', // Ethereum
  137: 'H1Et77RZh3XEf27vkAmJyzgCME2RSFLtDS2f4PPW6CGp', // Polygon
  43114: 'EZvK18pMhwiCjxwesRLTg81fP33WnR6BnZe5Cvma3H1C', // Avalanche
}

const getV2SubgraphEndpoint = (chainId: number): string | null => {
  const apiKey = process.env.THEGRAPH_API_KEY
  if (!apiKey) {
    return null
  }
  const subgraphId = V2_SUBGRAPH_IDS[chainId]
  if (!subgraphId) {
    return null
  }
  return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`
}

const CHAIN_ID_TO_FOLDER_NAME: Record<number, string> = {
  1: 'mainnet',
  137: 'polygon',
  43114: 'avalanche',
}

// V2 aToken symbol prefixes by chain
const V2_ATOKEN_PREFIX: Record<number, string> = {
  1: 'a', // Ethereum: aUSDC, aWETH
  137: 'am', // Polygon: amUSDC, amWETH
  43114: 'av', // Avalanche: avUSDC, avWETH
}

export const GET_AAVE_V2_RESERVES = `{
  reserves(first: 100) {
    id
    name
    symbol
    decimals
    aToken {
      id
    }
    underlyingAsset
  }
}`

type Reserve = {
  aToken: {
    address: string
    chainId: number
    decimals: number
    imageUrl?: string | null
    name: string
    symbol: string
  }
  underlyingToken?: {
    address?: string
    name?: string
    symbol?: string
    imageUrl?: string | null
    decimals?: number
  } | null
}

type V2AToken = {
  id: string // Token address
}

type V2Reserve = {
  id: string
  name: string
  symbol: string
  decimals: number
  aToken: V2AToken
  underlyingAsset: string
}

type V2ReservesResponse = {
  reserves?: V2Reserve[]
}

type Market = {
  chain?: {
    name: string
    chainId: number
  }
  name?: string
  reserves?: Reserve[]
}

type MarketsResponse = {
  markets?: Market[]
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
  version?: {
    major: number
    minor: number
    patch: number
  }
}

type GraphqlResponse<T> = {
  data?: T
  errors?: { message?: string }[]
}

async function fetchMarkets(chainIds: number[]) {
  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: GET_ALL_AAVE_MARKETS,
      variables: {
        request: { chainIds },
      },
    }),
  })

  if (!response.ok) {
    throw new Error(
      `Aave GraphQL request failed with status ${response.status}`
    )
  }

  const payload = (await response.json()) as GraphqlResponse<MarketsResponse>

  if (payload.errors?.length) {
    const messages = payload.errors
      .map(error => error.message ?? 'Unknown error')
      .join('; ')
    throw new Error(`Aave GraphQL returned errors: ${messages}`)
  }

  if (!payload.data) {
    throw new Error('Aave GraphQL response missing data')
  }

  return payload.data
}

const sanitizeExtensions = (extensions: Record<string, unknown>) => {
  const sanitized: Record<string, unknown> = {}

  Object.entries(extensions).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      sanitized[key] = value
    }
  })

  return sanitized
}

const transformReservesToTokens = (reserves: Reserve[]): TokenListEntry[] => {
  return reserves
    .filter(reserve => Boolean(reserve?.aToken?.address))
    .map(reserve => {
      const { aToken, underlyingToken } = reserve

      const extensions = sanitizeExtensions({
        aaveAToken: true,
        underlyingTokenAddress: underlyingToken?.address,
        underlyingTokenName: underlyingToken?.name,
        underlyingTokenSymbol: underlyingToken?.symbol,
        underlyingTokenDecimals: underlyingToken?.decimals,
        indexingInfo: {
          useOnChainBalance: true,
        },
      })

      return {
        chainId: aToken.chainId,
        address: aToken.address,
        name: aToken.name ?? aToken.symbol,
        symbol: aToken.symbol,
        decimals: aToken.decimals,
        logoURI: aToken.imageUrl ?? '',
        ...(Object.keys(extensions).length ? { extensions } : {}),
      }
    })
}

const normalizeChainFolderName = (chainName: string) =>
  chainName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^bsc$/, 'bnb')
    .replace(/^ethereum$/, 'mainnet')

const loadTokenList = async (
  chainName: string,
  chainId: number,
  tokenListPath: string
): Promise<TokenList> => {
  try {
    const raw = await fs.readFile(tokenListPath, 'utf-8')
    return JSON.parse(raw) as TokenList
  } catch (error) {
    const base: TokenList = {
      name: `sequence-erc20-${chainName}`,
      chainId,
      tokenStandard: 'erc20',
      logoURI: '',
      keywords: ['erc20', chainName],
      tokens: [],
      version: {
        major: 1,
        minor: 0,
        patch: 0,
      },
    }

    await fs.mkdir(path.dirname(tokenListPath), { recursive: true })
    return base
  }
}

const writeTokenList = async (tokenListPath: string, tokenList: TokenList) => {
  await fs.mkdir(path.dirname(tokenListPath), { recursive: true })
  await fs.writeFile(tokenListPath, `${JSON.stringify(tokenList, null, 2)}\n`)
}

const mergeTokens = (
  existingTokens: TokenListEntry[],
  newTokens: TokenListEntry[]
) => {
  const seenAddresses = new Set(
    existingTokens.map(token => token.address.toLowerCase())
  )
  const additions: TokenListEntry[] = []

  newTokens.forEach(token => {
    const key = token.address.toLowerCase()
    if (seenAddresses.has(key)) {
      return
    }

    seenAddresses.add(key)
    additions.push(token)
  })

  return additions
}

const processMarkets = async () => {
  console.log(
    `Fetching Aave tokens for chain IDs: ${TARGET_CHAIN_IDS.join(', ')}`
  )
  const data = await fetchMarkets(TARGET_CHAIN_IDS)
  const markets = data.markets ?? []

  if (!markets.length) {
    console.warn('No markets returned from API.')
    return
  }

  const chainBuckets = new Map<
    string,
    {
      chainId: number
      tokens: TokenListEntry[]
    }
  >()

  for (const market of markets) {
    const rawChainName =
      market.chain?.name ?? `chain-${market.chain?.chainId ?? 'unknown'}`
    const chainFolderName = normalizeChainFolderName(rawChainName)
    const chainId = market.chain?.chainId ?? 0

    const tokens = transformReservesToTokens(market.reserves ?? [])
    const bucket = chainBuckets.get(chainFolderName) ?? { chainId, tokens: [] }
    bucket.chainId = chainId
    bucket.tokens.push(...tokens)
    chainBuckets.set(chainFolderName, bucket)
  }

  for (const [chainFolderName, { chainId, tokens }] of chainBuckets.entries()) {
    const tokenListPath = path.join(
      TOKEN_DIRECTORY_ROOT,
      chainFolderName,
      'erc20.json'
    )
    console.log(
      `[${chainFolderName}] Processing ${tokens.length} tokens across markets.`
    )

    const tokenList = await loadTokenList(
      chainFolderName,
      chainId,
      tokenListPath
    )
    const additions = mergeTokens(tokenList.tokens, tokens)

    if (!additions.length) {
      console.log(`[${chainFolderName}] No new tokens to add.`)
      continue
    }

    tokenList.tokens.push(...additions)

    await writeTokenList(tokenListPath, tokenList)
    console.log(
      `[${chainFolderName}] Added ${additions.length} tokens -> ${tokenListPath}`
    )
  }
}

async function fetchV2Reserves(chainId: number): Promise<V2Reserve[]> {
  const endpoint = getV2SubgraphEndpoint(chainId)
  if (!endpoint) {
    return []
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: GET_AAVE_V2_RESERVES,
      }),
    })

    if (!response.ok) {
      console.warn(
        `[V2] Failed to fetch reserves for chain ${chainId}: HTTP ${response.status}`
      )
      return []
    }

    const payload = (await response.json()) as GraphqlResponse<V2ReservesResponse>

    if (payload.errors?.length) {
      const messages = payload.errors
        .map(error => error.message ?? 'Unknown error')
        .join('; ')
      console.warn(`[V2] GraphQL errors for chain ${chainId}: ${messages}`)
      return []
    }

    return payload.data?.reserves ?? []
  } catch (error) {
    console.warn(`[V2] Error fetching reserves for chain ${chainId}:`, error)
    return []
  }
}

const transformV2ReservesToTokens = (
  reserves: V2Reserve[],
  chainId: number
): TokenListEntry[] => {
  const prefix = V2_ATOKEN_PREFIX[chainId] ?? 'a'

  return reserves
    .filter(reserve => Boolean(reserve?.aToken?.id))
    .map(reserve => {
      const { aToken, underlyingAsset, name, symbol, decimals } = reserve

      // Derive aToken symbol/name from underlying (e.g., USDC -> amUSDC on Polygon)
      const aTokenSymbol = `${prefix}${symbol}`
      const aTokenName = `Aave V2 ${name ?? symbol}`

      const extensions = sanitizeExtensions({
        aaveAToken: true,
        underlyingTokenAddress: underlyingAsset,
        underlyingTokenName: name,
        underlyingTokenSymbol: symbol,
        underlyingTokenDecimals: decimals,
        indexingInfo: {
          useOnChainBalance: true,
        },
      })

      return {
        chainId,
        address: aToken.id,
        name: aTokenName,
        symbol: aTokenSymbol,
        decimals,
        logoURI: '',
        ...(Object.keys(extensions).length ? { extensions } : {}),
      }
    })
}

const processV2Markets = async () => {
  if (!process.env.THEGRAPH_API_KEY) {
    console.log(
      '\n[V2] Skipping Aave V2 tokens (THEGRAPH_API_KEY not set). ' +
        'Get a free API key at https://thegraph.com/studio/apikeys/'
    )
    return
  }

  const chainIds = Object.keys(V2_SUBGRAPH_IDS).map(Number)
  console.log(`\n[V2] Fetching Aave V2 tokens for chain IDs: ${chainIds.join(', ')}`)

  for (const chainId of chainIds) {
    const folderName = CHAIN_ID_TO_FOLDER_NAME[chainId]
    if (!folderName) {
      console.warn(`[V2] No folder name mapping for chain ${chainId}`)
      continue
    }

    const reserves = await fetchV2Reserves(chainId)
    if (!reserves.length) {
      console.log(`[V2][${folderName}] No reserves returned from subgraph.`)
      continue
    }

    const tokens = transformV2ReservesToTokens(reserves, chainId)
    console.log(`[V2][${folderName}] Processing ${tokens.length} V2 tokens.`)

    const tokenListPath = path.join(
      TOKEN_DIRECTORY_ROOT,
      folderName,
      'erc20.json'
    )

    const tokenList = await loadTokenList(folderName, chainId, tokenListPath)
    const additions = mergeTokens(tokenList.tokens, tokens)

    if (!additions.length) {
      console.log(`[V2][${folderName}] No new tokens to add.`)
      continue
    }

    tokenList.tokens.push(...additions)

    await writeTokenList(tokenListPath, tokenList)
    console.log(
      `[V2][${folderName}] Added ${additions.length} tokens -> ${tokenListPath}`
    )
  }
}

const main = async () => {
  await processMarkets()
  await processV2Markets()
}

main().catch(error => {
  console.error('Failed to update token lists:', error)
  process.exitCode = 1
})
