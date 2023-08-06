import 'dotenv/config';

import MevShareClient, { IPendingTransaction } from '@flashbots/mev-share-client';

import { Mutex } from 'async-mutex';

import { AsyncArray } from './async-array';

import { JsonRpcProvider, Network, Wallet } from 'ethers';

import { StreamEventType } from '@flashbots/mev-share-client/build/api/interfaces';

const AUTH_KEY = process.env.AUTH_KEY as string;
const RPC_URL  = process.env.RPC_URL  as string;

(async () => {

  const provider   = new JsonRpcProvider(RPC_URL, new Network('goerli', 5));

  const authSigner = new Wallet(AUTH_KEY).connect(provider);

  const client = MevShareClient.useEthereumGoerli(authSigner);

  const lock = new Mutex();

  const pendingTxHashes = new AsyncArray<string>();

  let conn: EventSource;

  try {

    conn = client.on(StreamEventType.Transaction, async (pendingTx: IPendingTransaction) => {

      pendingTxHashes.push(pendingTx.hash);

      if (!(await pendingTxHashes.includes(pendingTx.hash))) return;
      
      console.log(pendingTx);

      await pendingTxHashes.filter(hash => hash !== pendingTx.hash);

      console.log(`${pendingTx.hash} dropped`);

      lock.release();

    });

    await lock.acquire();

  } catch (error: unknown) {

    console.log((error as Error).message);

    lock.release();

    conn?.close();

  }

})()
