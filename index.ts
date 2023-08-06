import 'dotenv/config';

import MevShareClient, { IPendingTransaction } from '@flashbots/mev-share-client';
import { StreamEventType, BundleParams } from '@flashbots/mev-share-client/build/api/interfaces';
import { Mutex } from 'async-mutex';
import { AsyncArray } from './async-array';
import { Contract, JsonRpcProvider, Network, TransactionReceipt, TransactionRequest, Wallet, keccak256 } from 'ethers';

const AUTH_KEY   = process.env.AUTH_KEY   as string;
const RPC_URL    = process.env.RPC_URL    as string;
const SIGNER_KEY = process.env.SIGNER_KEY as string;

const CTF_SIMPLE_ADDRESS = '0x98997b55Bb271e254BEC8B85763480719DaB0E53';

const NUM_TARGET_BLOCKS = 25;
const REPEATED_BUNDLE_SUBMISSIONS = 3;

(async () => {

  const provider   = new JsonRpcProvider(RPC_URL, new Network('goerli', 5));
  const authSigner = new Wallet(AUTH_KEY).connect(provider);
  const signer     = new Wallet(SIGNER_KEY).connect(provider);

  const client = MevShareClient.useEthereumGoerli(authSigner);

  const lock = new Mutex();

  const pendingTxHashes = new AsyncArray<string>();

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

      const targetBlock = await provider.getBlockNumber();

      const request = await contract['claimReward'].populateTransaction();

      const sendBundle = async (): Promise<string[]> => {

        const bundles = [];

        for (let i = 0; i < REPEATED_BUNDLE_SUBMISSIONS; i++) {

          const claimRewardRequest: TransactionRequest = {
            ...request,
            type: 2,
            nonce: await signer.getNonce() + i,
            chainId: provider._network.chainId,
            value: 0,
            gasLimit: 4000,
            maxFeePerGas: BigInt(69),
            maxPriorityFeePerGas: BigInt(5),
          }

          const params: BundleParams = {
            body: [
              { hash: pendingTx.hash },
              {
                tx: await signer.signTransaction(claimRewardRequest),
                canRevert: false
              }
            ],
            inclusion: {
              block: targetBlock + i,
              maxBlock: targetBlock + NUM_TARGET_BLOCKS - i,
            }
          }

          const submission = await client.sendBundle(params);

          console.log(submission.bundleHash, params.inclusion.block, 'bundled' ,'\n');

          bundles.push(keccak256((params.body[1] as any).tx));

        }

        return bundles;
      }

      // watch future blocks to see if target transaction has ever makes it to the ledger.
      for (let i = 0; i < NUM_TARGET_BLOCKS; i++) {

        const current = targetBlock + i;
        
        if (!lock.isLocked()) {
          // mutex was released by another handler; bail.
          break
        }

        console.log(`${pendingTx.hash} ${current} waiting\n`);

        // sends (n) bundles to the relay
        // TODO: Determine if transaction has been built properly
        const bundles = await sendBundle();

        // stall until target block is available
        while (await provider.getBlockNumber() < current) {
          await new Promise(resolve => setTimeout(resolve, 3_000))
        }

        // check for receipts to bundles and original transaction hash
        // bail if any and assume we did not hit.
        // TODO: await Promise.all() a map of these but no dice. tis ugly.
        //   ```
        //   const receipts = await Promise.all([pendingTx.hash, ...bundles]
        //     .map((txHash) => provider.getTransactionReceipt(txHash)));
        //   ```
        //   throws not able to find provider
        const receipts = [];
        receipts.push(await provider.getTransactionReceipt(pendingTx.hash))
        // TODO: investigate better way to bacth call? 
        receipts.push(await provider.getTransactionReceipt(bundles[0]))
        receipts.push(await provider.getTransactionReceipt(bundles[1]))
        receipts.push(await provider.getTransactionReceipt(bundles[2]))

        const succeeded = receipts.filter((receipt: TransactionReceipt) => receipt?.status == 1);

        // log found transactions with block scanner
        // TODO: move magic string
        if (succeeded.length) {
          const msg = succeeded
            .map(({ hash }: TransactionReceipt): string => `found: https://goerli.etherscan.io/tx/${hash}\n`)
            .join('\n')

          console.log(msg);

          lock.release();

          // in any case the opportunity attached to this transaction has no longer exists; bail.
          break;

        } else {
          // neither the original transaction (logged) nor any of the bundled transactions were found.
          console.warn(`${pendingTx.hash} ${current} excluded\n`);
        }

      }

      // drop the pending transaction hash.
      await pendingTxHashes.filter(hash => hash !== pendingTx.hash);

      console.log(`${pendingTx.hash} dropped\n`);

      lock.release();

    });

    await lock.acquire();

  } catch (error: unknown) {

    console.log((error as Error).message);

    // TODO: look for a drain when time permits
    lock.release();

    conn?.close();

  }

})()
