// Local development: deploys the escrow factory, a mock USDC (with issuer blacklist) and the USDC
// freeze adapter to a local anvil node, and prints the environment the API and worker need.
// Production deployments use contracts/script/Deploy.s.sol (48h admin timelock).
import { createPublicClient, createWalletClient, http, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { escrowFactoryAbi, escrowFactoryBytecode } from '@backstop/shared';
import { mockUsdcAbi, mockUsdcBytecode, usdcFreezeAdapterAbi, usdcFreezeAdapterBytecode } from '../../../packages/shared/src/testing.generated.ts';

const url = process.env.ANVIL_URL ?? 'http://127.0.0.1:8545';
// anvil's well-known development keys (never use outside a local chain)
const ADMIN = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const ARBITER = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const KEEPER = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex;
const TREASURY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex;

const chain = { id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } } as Chain;
const pub = createPublicClient({ chain, transport: http(url) });
const admin = createWalletClient({ chain, transport: http(url), account: privateKeyToAccount(ADMIN) });

async function deploy(abi: readonly unknown[], bytecode: Hex, args: unknown[] = []): Promise<Hex> {
  const hash = await admin.deployContract({ abi: abi as never, bytecode, args: args as never });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
}

const usdc = await deploy(mockUsdcAbi, mockUsdcBytecode as Hex);
const adapter = await deploy(usdcFreezeAdapterAbi, usdcFreezeAdapterBytecode as Hex);
const factory = await deploy(escrowFactoryAbi, escrowFactoryBytecode as Hex, [privateKeyToAccount(ADMIN).address, privateKeyToAccount(ARBITER).address, privateKeyToAccount(TREASURY).address, 500, '0xff']);
for (const [fn, args] of [
  ['allowToken', [usdc]],
  ['setFreezeAdapter', [usdc, adapter]],
] as const) {
  const hash = await admin.writeContract({ address: factory, abi: escrowFactoryAbi, functionName: fn as never, args: args as never });
  await pub.waitForTransactionReceipt({ hash });
}
const start = await pub.getBlockNumber();
console.log(
  [
    `BASE_RPC_URLS=${url}`,
    'BASE_CHAIN_ID=31337',
    `BASE_FACTORY=${factory}`,
    `BASE_USDC=${usdc}`,
    'BASE_FINALITY=latest',
    `BASE_START_BLOCK=${start}`,
    `BASE_KEEPER_KEY=${KEEPER}`,
    `BASE_TREASURY=${privateKeyToAccount(TREASURY).address}`,
    `ARBITER_EXECUTOR_KEY=${ARBITER}`,
    `# mint test USDC: cast send ${usdc} "mint(address,uint256)" <addr> 1000000000 --private-key ${ADMIN} --rpc-url ${url}`,
  ].join('\n'),
);
