# MevShare Transaction Watcher

This project contains a script that listens to pending transactions on the Ethereum Goerli testnet. When a transaction event occurs, the corresponding transaction hash is logged to the console, and when the transaction is dropped, a message is printed indicating that it has been dropped.

## Prerequisites

You will need to have Node.js and npm installed on your system. Also, make sure you have the required dependencies for the script, including ethers, and @flashbots/mev-share-client, among others.

## Installation

1. **Clone the repository**:

```shell
git clone https://github.com/gaslimitreached/flashbots-ctf-20230805
```

2. **Navigate to the project directory**:

```shell
cd flashbots-ctf
```

3. **Install the dependencies**:

```shell
npm install
```

Make sure to include all the necessary dependencies, such as ethers, @flashbots/mev-share-client, and any others required by your project.

## Configuration

The script uses environment variables for authentication and RPC URL configuration. You will need to provide values for the following variables:

- `AUTH_KEY`: Your Ethereum private key.
- `RPC_URL`: The RPC URL of the Goerli testnet.

You can create a .env file in the project root and add these variables with your values:

```plaintext
AUTH_KEY=your_fb_reputation_private_key
RPC_URL=https://goerli.rpc.io
```

## Usage

You can run the script using the following command:

```shell
node start
```

The script will connect to the Goerli testnet using the provided RPC URL and authentication key, and it will start listening to transaction events. When a transaction event occurs, it will log the corresponding transaction details and notify that the transaction is dropped.

