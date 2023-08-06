import 'dotenv/config';

import MevShareClient, { IPendingTransaction } from '@flashbots/mev-share-client';
import { StreamEventType, BundleParams } from '@flashbots/mev-share-client/build/api/interfaces';
import { Mutex } from 'async-mutex';
import { AsyncArray } from './async-array';
import { Contract, JsonRpcProvider, Network, TransactionRequest, Wallet } from 'ethers';
import { writeFileSync } from 'node:fs';

const AUTH_KEY   = process.env.AUTH_KEY   as string;
const RPC_URL    = process.env.RPC_URL    as string;
const SIGNER_KEY = process.env.SIGNER_KEY as string;

const CTF_SIMPLE_ADDRESS = '0x98997b55Bb271e254BEC8B85763480719DaB0E53';

const NUM_TARGET_BLOCKS = 25;

// JSON.stringify() doesn't know how to serialize a BigInt
// https://github.com/GoogleChromeLabs/jsbi/issues/30
// eslint-disable-next-line @typescript-eslint/no-redeclare
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

(async () => {

  const provider   = new JsonRpcProvider(RPC_URL, new Network('goerli', 5));
  const authSigner = new Wallet(AUTH_KEY).connect(provider);
  const signer     = new Wallet(SIGNER_KEY).connect(provider);

  const client = MevShareClient.useEthereumGoerli(authSigner);

  const lock = new Mutex();

  const pendingTxHashes = new AsyncArray<string>();

  const feedata = await provider.getFeeData();

  let conn: EventSource;

  try {

    conn = client.on(StreamEventType.Transaction, async (pendingTx: IPendingTransaction) => {

      pendingTxHashes.push(pendingTx.hash);

      if (!(await pendingTxHashes.includes(pendingTx.hash))) return;

      // get `to` address from transaction logs
      const [{ address }] = (pendingTx.logs ?? [{}]);

      // isolate the target contract
      if (!address || address.toLowerCase() !== CTF_SIMPLE_ADDRESS.toLowerCase()) return;

      const abi = ['function claimReward() external'];

      const contract = new Contract(address, abi , provider)

      // It may take multiple blocks to successfully land a CTF bundle on Goerli. Not
      // every block in Goerli is built by Flashbots, and bundles submitted for other
      // blocks will not succeed even if your solution is correct. Bundles should be
      // submitted repeatedly, for sequential blocks, until they land on-chain.

      const request = await contract['claimReward'].populateTransaction();

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

      const target = await provider.getBlockNumber();

      // build bundle
      const params: BundleParams = {
        body: [
          pendingTx,
          {
            tx: await signer.signTransaction(backrun),
            canRevert: false
          }
        ],
        inclusion: {
          block: target,
          maxBlock: target + NUM_TARGET_BLOCKS,
        }
      }

      // watch future blocks to see if target transaction has ever makes it to the ledger.
      const targetBlock = await provider.getBlockNumber();

      for (let i = 0; i < NUM_TARGET_BLOCKS; i++) {
        const current = targetBlock + i;

        if (!lock.isLocked()) {
          // mutex was released by another handler; bail.
          break
        }
        console.log(`${pendingTx.hash} ${current} waiting\n`);

        // stall until target block is available
        while (await provider.getBlockNumber() < current) {
          await new Promise(resolve => setTimeout(resolve, 6_000));
        }

        const receipt = await provider.getTransactionReceipt(pendingTx.hash);

        if (!receipt || receipt.status != 1) continue;

        // once the original transaction has landed we can simulate our bundle
        // TODO: simulate the transaction on a fork
        try {
          const simBundleResult = await client.simulateBundle(params);

          console.log`sim:\n${pendingTx}\n${params}\n${simBundleResult}\n`;

          writeFileSync(`data/${pendingTx.hash}.json`, JSON.stringify(pendingTx));

          break;
        } catch (err: unknown) {
          console.log((err as Error).message);
          lock.release();
        }

      }

      // drop the pending transaction hash.
      await pendingTxHashes.filter(hash => hash !== pendingTx.hash);

      console.log(`${pendingTx.hash} dropped\n`);
    });

    await lock.acquire();

  } catch (error: unknown) {
    console.log((error as Error).message);
    conn?.close();
  }
})()
