import 'dotenv/config';

import MevShareClient, {
  IPendingTransaction,
} from '@flashbots/mev-share-client';
import { ISimBundleResult } from '@flashbots/mev-share-client/build/api/interfaces';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { readFileSync } from 'node:fs';

const EXECUTOR_KEY = process.env.SIGNER_KEY as string;
const FB_REPUTATION_PRIVATE_KEY = process.env.AUTH_KEY as string;
const RPC_URL = process.env.RPC_URL as string;
const CTF_SIMPLE_ADDRESS = '0x98997b55Bb271e254BEC8B85763480719DaB0E53';

const TX_GAS_LIMIT = 400000;
const BLOCKS_TO_TRY = 24;

const MAX_GAS_PRICE = 40n;
const MAX_PRIORITY_FEE = 0n;

const GWEI = 10n ** 9n;

const provider = new JsonRpcProvider(RPC_URL);

const signer = new Wallet(EXECUTOR_KEY, provider);
const authSigner = new Wallet(FB_REPUTATION_PRIVATE_KEY, provider);
const abi = readFileSync('./bindings/abi.txt').toString();
const contract = new Contract(CTF_SIMPLE_ADDRESS, abi, provider);

const client = MevShareClient.useEthereumGoerli(authSigner);

// JSON.stringify() doesn't know how to serialize a BigInt
// https://github.com/GoogleChromeLabs/jsbi/issues/30
// eslint-disable-next-line @typescript-eslint/no-redeclare
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function getSignedBackrunTx(nonce: number) {
  const claimRewardTx = await contract['claimReward'].populateTransaction();
  const backrunTxFull = {
    ...claimRewardTx,
    chainId: 5,
    maxFeePerGas: MAX_GAS_PRICE * GWEI,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE * GWEI,
    gasLimit: TX_GAS_LIMIT,
    nonce: nonce,
  };
  return signer.signTransaction(backrunTxFull);
}

// function bigintJsonEncoder(key: any, value: any) {
//   return typeof value === 'bigint' ? value.toString() : value;
// }

async function backrunAttempt(
  currentBlockNumber: number,
  nonce: number,
  pendingTxHash: string
) {
  const backrunSignedTx = await getSignedBackrunTx(nonce);
  try {
    const mevShareBundle = {
      inclusion: { block: currentBlockNumber + 1 },
      body: [
        { hash: pendingTxHash },
        { tx: backrunSignedTx, canRevert: false },
      ],
    };
    const sendBundleResult = await client.sendBundle(mevShareBundle);
    console.log('📦' + sendBundleResult.bundleHash);
    if (process.env.BUNDLE_SIMULATION !== undefined) {
      client
        .simulateBundle(mevShareBundle)
        .then((simResult: ISimBundleResult) => {
          console.log(`🟡 ${sendBundleResult.bundleHash}`);
          // console.log(JSON.stringify(simResult, bigintJsonEncoder));
          console.log(JSON.stringify(simResult));
        })
        .catch((error: unknown) => {
          console.log(
            `🔴 ${sendBundleResult.bundleHash}`
          );
          console.warn(error);
        });
    }
  } catch (e) {
    console.log('err', e);
  }
}

function transactionIsRelated(
  pendingTx: IPendingTransaction,
  PAIR_ADDRESS: string
) {
  return (
    pendingTx.to === PAIR_ADDRESS ||
    (pendingTx.logs || []).some((log) => log.address === PAIR_ADDRESS)
  );
}

async function main() {
  console.log(`🤖 ${authSigner.address}`);
  console.log(`🔏 ${signer.address}`);

  const nonce = await signer.getNonce('latest');

  let recentPendingTxHashes: Array<{ txHash: string; blockNumber: number }> =
    [];

  client.on('transaction', async (pendingTx: IPendingTransaction) => {
    if (!transactionIsRelated(pendingTx, CTF_SIMPLE_ADDRESS)) {
      console.log(`🙈 ${pendingTx.hash}`);
      return;
    }
    console.log(`🎯 ${pendingTx.hash}`);
    const currentBlockNumber = await provider.getBlockNumber();
    backrunAttempt(currentBlockNumber, nonce, pendingTx.hash);
    recentPendingTxHashes.push({
      txHash: pendingTx.hash,
      blockNumber: currentBlockNumber,
    });
  });

  provider.on('block', (blockNumber) => {
    for (const recentPendingTxHash of recentPendingTxHashes) {
      console.log(recentPendingTxHash);
      backrunAttempt(blockNumber, nonce, recentPendingTxHash.txHash);
    }
    // Cleanup old pendingTxHashes
    recentPendingTxHashes = recentPendingTxHashes.filter(
      (recentPendingTxHash) =>
        blockNumber > recentPendingTxHash.blockNumber + BLOCKS_TO_TRY
    );
  });
}

main();
