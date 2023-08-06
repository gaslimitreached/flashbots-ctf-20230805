import 'dotenv/config';

import MevShareClient, { IPendingTransaction } from '@flashbots/mev-share-client';
import { BundleParams, StreamEventType } from '@flashbots/mev-share-client/build/api/interfaces';

import { Mutex } from 'async-mutex';

import { AsyncArray } from './async-array';

import { Contract, JsonRpcProvider, Network, TransactionRequest, Wallet } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';

const AUTH_KEY = process.env.AUTH_KEY as string;
const RPC_URL = process.env.RPC_URL as string;
const SIGNER_KEY = process.env.SIGNER_KEY as string;

const NUM_TARGET_BLOCKS = 25;
const CTF_SIMPLE_ADDRESS = '0x98997b55Bb271e254BEC8B85763480719DaB0E53';

// JSON.stringify() doesn't know how to serialize a BigInt
// https://github.com/GoogleChromeLabs/jsbi/issues/30
// eslint-disable-next-line @typescript-eslint/no-redeclare
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

(async () => {
  const abi = readFileSync('./bindings/abi.txt').toString();
  const provider = new JsonRpcProvider(RPC_URL, new Network('goerli', 5));
  const authSigner = new Wallet(AUTH_KEY).connect(provider);
  const signer = new Wallet(SIGNER_KEY).connect(provider);

  const client = MevShareClient.useEthereumGoerli(authSigner);

  const lock = new Mutex();

  const pendingTxHashes = new AsyncArray<string>();

  let conn: EventSource;

  try {
    conn = client.on(
      StreamEventType.Transaction,
      async (pendingTx: IPendingTransaction) => {
        pendingTxHashes.push(pendingTx.hash);

        if (!(await pendingTxHashes.includes(pendingTx.hash))) return;

        const [{ address }] = pendingTx.logs ?? [{}];

        // target simple contract
        if (!address) return;
        if (address.toLowerCase() !== CTF_SIMPLE_ADDRESS.toLowerCase()) return;

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
          maxFeePerGas: feedata.maxFeePerGas + pendingTx.mevGasPrice,
          maxPriorityFeePerGas: pendingTx.mevGasPrice,
        };

        // target for the next block
        const targetBlock = (await provider.getBlockNumber()) + 1;

        const params: BundleParams = {
          body: [
            {
              ...pendingTx,
              to: address,
            } as IPendingTransaction,
            {
              tx: await signer.connect(provider).signTransaction(backrun),
              canRevert: false,
            },
          ],
          inclusion: {
            block: targetBlock,
            // NUM_TARGET_BLOCKS less one since our target is plus one.
            maxBlock: targetBlock + NUM_TARGET_BLOCKS - 1,
          },
        };

        await client.sendBundle(params);

        console.log(pendingTx.hash, params.inclusion.block, `📦`, '\n');

        for (let i = 0; i < NUM_TARGET_BLOCKS; i++) {
          const current = targetBlock + i;

          if (!lock.isLocked()) {
            // mutex was released by another handler; bail.
            break;
          }

          console.log(`${pendingTx.hash} ${current} ⏳\n`);

          // stall until target block is available
          while ((await provider.getBlockNumber()) < current) {
            await new Promise((resolve) => setTimeout(resolve, 3_000));
          }

          // check for receipts to bundles and original transaction hash
          // bail if any and assume we did not hit.
          const receipt = await provider.getTransactionReceipt(pendingTx.hash);

          if (receipt?.status === 1) {
            // save a bundle to simulate against
            writeFileSync(`data/${pendingTx.hash}.json`, JSON.stringify(pendingTx));

            console.log(`${receipt?.hash} ${await provider.getBlockNumber()} 🎯\n`);

            break;
          } else {
            // console.warn(`${pendingTx.hash} ${current} 🔍\n`);
          }
        }

        await pendingTxHashes.filter((hash) => hash !== pendingTx.hash);

        console.log(`${pendingTx.hash} dropped 🩸\n`);
      }
    );

    await lock.acquire();
  } catch (error: unknown) {
    console.log((error as Error).message);

    lock.release();

    conn?.close();
  }
})();
