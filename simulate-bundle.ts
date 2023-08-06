import 'dotenv/config';

import { readFileSync } from 'node:fs';

import MevShareClient, { IPendingTransaction } from '@flashbots/mev-share-client';
import { BundleParams } from '@flashbots/mev-share-client/build/api/interfaces';
import { Contract, JsonRpcProvider, Network, TransactionReceipt, TransactionRequest, Wallet } from 'ethers';

const AUTH_KEY   = process.env.AUTH_KEY   as string;
const RPC_URL    = process.env.RPC_URL    as string;
const SIGNER_KEY = process.env.SIGNER_KEY as string;

const NUM_TARGET_BLOCKS = 25;

async function simulateBundle(client: MevShareClient, params: BundleParams, blockNumber?: number) {
  return client.simulateBundle(params, { blockNumber });
}

const abi = ['function claimReward() external'];
(async () => {

  const provider   = new JsonRpcProvider(RPC_URL, new Network('goerli', 5));
  const authSigner = new Wallet(AUTH_KEY).connect(provider);
  const signer     = new Wallet(SIGNER_KEY).connect(provider);

  const client = MevShareClient.useEthereumGoerli(authSigner);

  let conn: EventSource;

  try {

    const [ blockNumber ] = process.argv;
    // TODO: take block number as command line argument

    // get pending transaction from file and simulate at a specific block
    const raw = JSON.parse(readFileSync('data/test-transaction.json').toString()) as IPendingTransaction;

    const pendingTx: IPendingTransaction = {
       ...raw,
       gasUsed: BigInt(raw.gasUsed),
       mevGasPrice: BigInt(raw.mevGasPrice),
    }

    console.log(raw);

    const [{ address }] = (pendingTx.logs ?? [{}]);

    const contract = new Contract(address, abi , provider);

    const request = await contract['claimReward'].populateTransaction();

    const feedata = await provider.getFeeData();

    const backrun: TransactionRequest = {
      ...request,
      type: 2,
      nonce: await signer.getNonce(),
      chainId: provider._network.chainId,
      value: 0,
      gasLimit: 42_000,
      maxFeePerGas: feedata.maxFeePerGas +  pendingTx.mevGasPrice,
      maxPriorityFeePerGas: pendingTx.mevGasPrice,
    }

    const inclusion = {
      block: parseInt(blockNumber) || await provider.getBlockNumber(),
    }

    const params: BundleParams = {
      body: [
        pendingTx,
        {
          tx: await signer.connect(provider).signTransaction(backrun),
          canRevert: false
        }
      ],
      inclusion: {
        ...inclusion,
        maxBlock: inclusion.block + NUM_TARGET_BLOCKS,
      }
    }

    await simulateBundle(client, params, parseInt(blockNumber) || undefined);

    throw new Error('Not Implemented');

  } catch (error: unknown) {
    console.log((error as Error).message);
  }
})()
