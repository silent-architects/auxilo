const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { base } = require('viem/chains');

// Fixed test wallet for reproducible tests
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Anvil account 0
const account = privateKeyToAccount(TEST_PRIVATE_KEY);

const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
});

/**
 * Sign EIP-712 challenge
 */
async function signChallenge(domain, types, nonce, timestamp, action = 'authenticate') {
    return await walletClient.signTypedData({
        domain,
        types,
        primaryType: 'Challenge',
        message: {
            wallet: account.address,
            nonce,
            timestamp: BigInt(timestamp),
            action,
        }
    });
}

/**
 * Sign EIP-712 withdrawal
 */
async function signWithdrawal(domain, types, amount, nonce, timestamp) {
    return await walletClient.signTypedData({
        domain,
        types,
        primaryType: 'Withdrawal',
        message: {
            wallet: account.address,
            amount,
            nonce,
            timestamp: BigInt(timestamp),
        }
    });
}

module.exports = {
    TEST_PRIVATE_KEY,
    account,
    testAddress: account.address,
    signChallenge,
    signWithdrawal,
};
