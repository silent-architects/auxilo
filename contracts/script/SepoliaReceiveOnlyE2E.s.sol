// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {AuxiloSplitRouterReceiveOnly} from "../AuxiloSplitRouterReceiveOnly.sol";

interface IFiatTokenLike {
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

/**
 * SepoliaReceiveOnlyE2E — one-shot live exercise of AuxiloSplitRouterReceiveOnly
 * on Base Sepolia.
 *
 * One funded key (env DEPLOYER_PK) plays deployer + settler + buyer-funder.
 * The script: deploys the receive-only router, funds a throwaway buyer with 1
 * USDC, has the buyer sign a ReceiveWithAuthorization off-chain (vm.sign — no
 * buyer ETH needed), then settles via settleAndSplitReceive and asserts the
 * 70/30 split landed with router residue 0.
 *
 * Env:
 *   DEPLOYER_PK  (required) raw uint256 private key; needs ~0.005 ETH + >=1 USDC
 *   BUYER_PK     (optional) throwaway buyer key; default derived from deployer
 *   FEE_WALLET   (optional) fee destination; default fresh derived address
 *   E2E_SALT     (optional) bytes32 salt; default unique per run (timestamp-mixed)
 *
 * Run:
 *   forge script script/SepoliaReceiveOnlyE2E.s.sol --rpc-url base_sepolia --broadcast -vvv
 */
contract SepoliaReceiveOnlyE2E is Script {
    /// Circle-verified Base Sepolia USDC (FiatTokenV2_2 behind ZOS proxy).
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    // keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 internal constant RECEIVE_TYPEHASH = 0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;

    uint256 internal constant VALUE = 1e6; // 1 USDC
    uint256 internal constant BPS = 7000; // 70% contributor / 30% fee

    IFiatTokenLike internal usdc = IFiatTokenLike(USDC);

    // Actors live in storage to keep run()'s stack shallow.
    uint256 internal deployerPk;
    address internal deployer; // == settler
    uint256 internal buyerPk;
    address internal buyer;
    address internal feeWallet;
    address internal contributor;
    bytes32 internal salt;
    uint256 internal validBefore;

    function run() external {
        _loadActors();
        _preflight();

        uint256 contributorBefore = usdc.balanceOf(contributor);
        uint256 feeBefore = usdc.balanceOf(feeWallet);

        vm.startBroadcast(deployerPk);

        // 1. Deploy receive-only router: usdc = Base Sepolia USDC, settler = deployer.
        AuxiloSplitRouterReceiveOnly router = new AuxiloSplitRouterReceiveOnly(USDC, feeWallet, deployer);
        console2.log("router deployed  :", address(router));

        // 2. Fund the buyer with exactly 1 USDC from the deployer.
        require(usdc.transfer(buyer, VALUE), "buyer funding transfer failed");

        // 3. Buyer signs ReceiveWithAuthorization OFF-CHAIN over the DERIVED nonce
        //    keccak256(abi.encode(contributor, 7000, salt)), using the real token's
        //    on-chain DOMAIN_SEPARATOR(). vm.sign is a cheatcode — no buyer gas.
        bytes32 nonce = keccak256(abi.encode(contributor, BPS, salt));
        bytes memory signature = _signReceive(address(router), nonce);
        console2.log("derived nonce    :");
        console2.logBytes32(nonce);

        // 4. Settler (= deployer) settles: pull 1 USDC from buyer, split 70/30.
        router.settleAndSplitReceive(buyer, VALUE, 0, validBefore, salt, signature, contributor, BPS);

        vm.stopBroadcast();

        _assertAndReport(router, contributorBefore, feeBefore);
    }

    function _loadActors() internal {
        deployerPk = vm.envUint("DEPLOYER_PK");
        deployer = vm.addr(deployerPk);
        buyerPk = vm.envOr("BUYER_PK", uint256(keccak256(abi.encodePacked("auxilo-sepolia-e2e-ro/buyer", deployer))));
        buyer = vm.addr(buyerPk);
        feeWallet = vm.envOr(
            "FEE_WALLET", vm.addr(uint256(keccak256(abi.encodePacked("auxilo-sepolia-e2e-ro/feeWallet", deployer))))
        );
        contributor = vm.addr(uint256(keccak256(abi.encodePacked("auxilo-sepolia-e2e-ro/contributor", deployer))));
        salt = vm.envOr(
            "E2E_SALT", keccak256(abi.encodePacked("auxilo-sepolia-e2e-ro", deployer, block.timestamp, block.number))
        );
        validBefore = block.timestamp + 1 hours;

        console2.log("deployer/settler :", deployer);
        console2.log("buyer (throwaway):", buyer);
        console2.log("contributor      :", contributor);
        console2.log("feeWallet        :", feeWallet);
        console2.log("salt             :");
        console2.logBytes32(salt);
    }

    /// Fails HERE, before any broadcast, if the deployer is unfunded.
    function _preflight() internal view {
        require(
            deployer.balance >= 0.00005 ether,
            "PRE-FLIGHT: deployer needs Base Sepolia ETH (>=0.00005). Fund via a Base Sepolia faucet."
        );
        require(
            usdc.balanceOf(deployer) >= VALUE,
            "PRE-FLIGHT: deployer needs >= 1 USDC on Base Sepolia. Fund via https://faucet.circle.com (Base Sepolia)."
        );
    }

    function _signReceive(address router, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, buyer, router, VALUE, uint256(0), validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Asserts the simulated end-state; --broadcast replays the identical txs.
    function _assertAndReport(AuxiloSplitRouterReceiveOnly router, uint256 contributorBefore, uint256 feeBefore)
        internal
        view
    {
        uint256 contributorGain = usdc.balanceOf(contributor) - contributorBefore;
        uint256 feeGain = usdc.balanceOf(feeWallet) - feeBefore;

        require(contributorGain == 700_000, "ASSERT FAIL: contributor did not receive 0.70 USDC");
        require(feeGain == 300_000, "ASSERT FAIL: feeWallet did not receive 0.30 USDC");
        require(usdc.balanceOf(address(router)) == 0, "ASSERT FAIL: router balance not zero");
        require(usdc.balanceOf(buyer) == 0, "ASSERT FAIL: buyer not fully debited");

        console2.log("");
        console2.log("=== E2E RECEIVE-ONLY SPLIT OK ===");
        console2.log("router                 :", address(router));
        console2.log("contributor +USDC (6dp):", contributorGain); // 700000 = 0.70 USDC
        console2.log("feeWallet   +USDC (6dp):", feeGain); //          300000 = 0.30 USDC
        console2.log("router balance         :", usdc.balanceOf(address(router)));
        console2.log("");
        console2.log("Tx hashes: broadcast/SepoliaReceiveOnlyE2E.s.sol/84532/run-latest.json");
    }
}
