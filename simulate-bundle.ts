import 'dotenv/config';

import { readFileSync } from 'node:fs';

import MevShareClient, { IPendingTransaction } from '@flashbots/mev-share-client';
import { BundleParams } from '@flashbots/mev-share-client/build/api/interfaces';
import { Contract, Interface, JsonRpcProvider, Network, TransactionReceipt, TransactionRequest, Wallet } from 'ethers';

const AUTH_KEY   = process.env.AUTH_KEY   as string;
const RPC_URL    = process.env.RPC_URL    as string;
const SIGNER_KEY = process.env.SIGNER_KEY as string;

async function simulateBundle(client: MevShareClient, params: BundleParams, blockNumber?: number) {
  return client.simulateBundle(params, { blockNumber });
}

(async () => {

  const abi = readFileSync('./bindings/abi.txt').toString();
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

    const contract = new Contract(address, abi, provider);

    const request = contract['claimReward'].populateTransaction();

    const feedata = await provider.getFeeData();

    const backrun: TransactionRequest = {
      ...request,
      type: 2,
      nonce: await signer.getNonce(),
      chainId: provider._network.chainId,
      value: 0,
      gasLimit: 60_000,
      maxFeePerGas: feedata.maxFeePerGas +  pendingTx.mevGasPrice,
      maxPriorityFeePerGas: pendingTx.mevGasPrice,
    }

    const inclusion = {
      block: 9473523,
    }

    const params: BundleParams = {
      body: [
        {
          ...pendingTx,
          to: address,
        } as IPendingTransaction,
        {
          tx: await signer.connect(provider).signTransaction(backrun),
          canRevert: false
        }
      ],
      inclusion,
    }

    const result = await simulateBundle(client, params, 9473523);

    console.log(pendingTx);
    console.log(backrun);
    console.log(params);
    console.log(result);

  } catch (error: unknown) {
    console.log((error as Error).message);
  }
})()
