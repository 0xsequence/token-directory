import path from 'node:path';
import { promises as fs } from 'node:fs';

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

const endpointUrl = 'https://api.v3.aave.com/graphql';
const TOKEN_DIRECTORY_ROOT = path.resolve('./index');
const TARGET_CHAIN_IDS: number[] = [1, 42161, 43114, 8453, 56, 100, 10, 137, 84532];

type Reserve = {
    aToken: {
        address: string;
        chainId: number;
        decimals: number;
        imageUrl?: string | null;
        name: string;
        symbol: string;
    };
    underlyingToken?: {
        address?: string;
        name?: string;
        symbol?: string;
        imageUrl?: string | null;
        decimals?: number;
    } | null;
};

type Market = {
    chain?: {
        name: string;
        chainId: number;
    };
    name?: string;
    reserves?: Reserve[];
};

type MarketsResponse = {
    markets?: Market[];
};

type TokenListEntry = {
    chainId: number;
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI: string;
    extensions?: Record<string, unknown>;
    indexingInfo: {
        useOnChainBalance: true;
    };
};

type TokenList = {
    name: string;
    chainId: number;
    tokenStandard: 'erc20';
    logoURI: string;
    keywords: string[];
    tokens: TokenListEntry[];
    version?: {
        major: number;
        minor: number;
        patch: number;
    };
};

type GraphqlResponse<T> = {
    data?: T;
    errors?: { message?: string }[];
};

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
    });

    if (!response.ok) {
        throw new Error(`Aave GraphQL request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as GraphqlResponse<MarketsResponse>;

    if (payload.errors?.length) {
        const messages = payload.errors.map(error => error.message ?? 'Unknown error').join('; ');
        throw new Error(`Aave GraphQL returned errors: ${messages}`);
    }

    if (!payload.data) {
        throw new Error('Aave GraphQL response missing data');
    }

    return payload.data;
}

const sanitizeExtensions = (extensions: Record<string, unknown>) => {
    const sanitized: Record<string, unknown> = {};

    Object.entries(extensions).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            sanitized[key] = value;
        }
    });

    return sanitized;
};

const transformReservesToTokens = (reserves: Reserve[]): TokenListEntry[] => {
    return reserves
        .filter(reserve => Boolean(reserve?.aToken?.address))
        .map(reserve => {
            const { aToken, underlyingToken } = reserve;

            const extensions = sanitizeExtensions({
                aaveAToken: true,
                underlyingTokenAddress: underlyingToken?.address,
                underlyingTokenName: underlyingToken?.name,
                underlyingTokenSymbol: underlyingToken?.symbol,
                underlyingTokenDecimals: underlyingToken?.decimals,
            });

            return {
                chainId: aToken.chainId,
                address: aToken.address,
                name: aToken.name ?? aToken.symbol,
                symbol: aToken.symbol,
                decimals: aToken.decimals,
                logoURI: aToken.imageUrl ?? '',
                ...(Object.keys(extensions).length ? { extensions } : {}),
                indexingInfo: {
                    useOnChainBalance: true,
                },
            };
        });
};

const normalizeChainFolderName = (chainName: string) =>
    chainName
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/^bsc$/, 'bnb')
        .replace(/^ethereum$/, 'mainnet');

const loadTokenList = async (
    chainName: string,
    chainId: number,
    tokenListPath: string,
): Promise<TokenList> => {
    try {
        const raw = await fs.readFile(tokenListPath, 'utf-8');
        return JSON.parse(raw) as TokenList;
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
        };

        await fs.mkdir(path.dirname(tokenListPath), { recursive: true });
        return base;
    }
};

const writeTokenList = async (tokenListPath: string, tokenList: TokenList) => {
    await fs.mkdir(path.dirname(tokenListPath), { recursive: true });
    await fs.writeFile(tokenListPath, `${JSON.stringify(tokenList, null, 2)}\n`);
};

const mergeTokens = (existingTokens: TokenListEntry[], newTokens: TokenListEntry[]) => {
    const seenAddresses = new Set(existingTokens.map(token => token.address.toLowerCase()));
    const additions: TokenListEntry[] = [];

    newTokens.forEach(token => {
        const key = token.address.toLowerCase();
        if (seenAddresses.has(key)) {
            return;
        }

        seenAddresses.add(key);
        additions.push(token);
    });

    return additions;
};

const processMarkets = async () => {
    console.log(`Fetching Aave tokens for chain IDs: ${TARGET_CHAIN_IDS.join(', ')}`);
    const data = await fetchMarkets(TARGET_CHAIN_IDS);
    const markets = data.markets ?? [];

    if (!markets.length) {
        console.warn('No markets returned from API.');
        return;
    }

    const chainBuckets = new Map<
        string,
        {
            chainId: number;
            tokens: TokenListEntry[];
        }
    >();

    for (const market of markets) {
        const rawChainName = market.chain?.name ?? `chain-${market.chain?.chainId ?? 'unknown'}`;
        const chainFolderName = normalizeChainFolderName(rawChainName);
        const chainId = market.chain?.chainId ?? 0;

        const tokens = transformReservesToTokens(market.reserves ?? []);
        const bucket = chainBuckets.get(chainFolderName) ?? { chainId, tokens: [] };
        bucket.chainId = chainId;
        bucket.tokens.push(...tokens);
        chainBuckets.set(chainFolderName, bucket);
    }

    for (const [chainFolderName, { chainId, tokens }] of chainBuckets.entries()) {
        const tokenListPath = path.join(TOKEN_DIRECTORY_ROOT, chainFolderName, 'erc20.json');
        console.log(`[${chainFolderName}] Processing ${tokens.length} tokens across markets.`);

        const tokenList = await loadTokenList(chainFolderName, chainId, tokenListPath);
        const additions = mergeTokens(tokenList.tokens, tokens);

        if (!additions.length) {
            console.log(`[${chainFolderName}] No new tokens to add.`);
            continue;
        }

        tokenList.tokens.push(...additions);

        await writeTokenList(tokenListPath, tokenList);
        console.log(`[${chainFolderName}] Added ${additions.length} tokens -> ${tokenListPath}`);
    }
};

const main = async () => {
    await processMarkets();
};

main().catch(error => {
    console.error('Failed to update token lists:', error);
    process.exitCode = 1;
});