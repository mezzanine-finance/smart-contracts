import {ethers, upgrades, network, run} from "hardhat";
import {
    loadDeployments,
    saveDeployments,
    recordDeployment,
    getLatestDeployment,
} from "./utils/deployments";
import {DEPLOY_INFO} from "./deployInfo";

async function verifyContract(address: string, constructorArguments: any[] = []) {
    if (network.name === "hardhat") {
        console.log("Skipping verification on hardhat network");
        return;
    }

    try {
        console.log(`Verifying contract at ${address}...`);
        await run("verify:verify", {
            address,
            constructorArguments,
        });
        console.log("Verification successful ✅");
    } catch (error: any) {
        console.log("Verification failed or already verified:", error?.message ?? error);
    }
}

function getTrancheAddresses(deployments: ReturnType<typeof loadDeployments>, netName: string) {
    const trancheRecords = deployments[netName]?.Tranche ?? [];
    return trancheRecords.map((record) => record.address).filter(Boolean);
}

async function main() {
    const [deployer] = await ethers.getSigners();
    const netName = network.name;

    const info = DEPLOY_INFO[netName];
    if (!info) {
        throw new Error(`DeployInfo not found for network: ${netName}`);
    }

    console.log("=== Deploy EmergencyLevelManager + Configurator ===");
    console.log("Network:", netName);
    console.log("Deployer:", deployer.address);

    const deployments = loadDeployments();

    const accessManagerRecord = getLatestDeployment(deployments, netName, "AccessManager");
    const mzusdRecord = getLatestDeployment(deployments, netName, "MZUSD");
    const reservoirRecord = getLatestDeployment(deployments, netName, "ReservoirUSDC");
    const vaultRecord = getLatestDeployment(deployments, netName, "Vault");
    const lossManagerRecord = getLatestDeployment(deployments, netName, "LossManager");
    const polJuniorRecord = getLatestDeployment(deployments, netName, "PolJuniorTranche");

    const trancheAddresses = getTrancheAddresses(deployments, netName);

    const accessManagerAddress = accessManagerRecord?.address;
    const mzusdAddress = mzusdRecord?.address;
    const reservoirAddress = reservoirRecord?.address;
    const vaultAddress = vaultRecord?.address;
    const lossManagerAddress = lossManagerRecord?.address;
    const polJuniorAddress = polJuniorRecord?.address;

    if (!accessManagerAddress) {
        throw new Error("AccessManager not deployed for this network. Deploy it first.");
    }
    if (!mzusdAddress || !reservoirAddress || !vaultAddress || !lossManagerAddress) {
        throw new Error(
            "Core contracts not deployed. Deploy MZUSD/Reservoir/Vault/LossManager first."
        );
    }
    if (!polJuniorAddress) {
        throw new Error("PolJuniorTranche not deployed for this network. Deploy it first.");
    }
    if (trancheAddresses.length === 0) {
        throw new Error("No Tranche deployments found. Deploy tranches first.");
    }

    console.log("AccessManager:", accessManagerAddress);
    console.log("MZUSD:", mzusdAddress);
    console.log("ReservoirUSDC:", reservoirAddress);
    console.log("Vault:", vaultAddress);
    console.log("LossManager:", lossManagerAddress);
    console.log("PolJuniorTranche:", polJuniorAddress);
    console.log("Tranches:", trancheAddresses.join(", "));

    const accessManager = await ethers.getContractAt(
        "AccessManager",
        accessManagerAddress,
        deployer
    );
    const ADMIN_ROLE = await accessManager.ADMIN_ROLE();
    const [isAdmin] = await accessManager.hasRole(ADMIN_ROLE, deployer.address);
    if (!isAdmin) {
        throw new Error(
            "Deployer must have ADMIN_ROLE on AccessManager to configure emergency levels."
        );
    }

    const guardian = info.emergencyEscalate ?? info.accessManagerAdmin;
    const governor = info.emergencyRelax ?? info.accessManagerAdmin;
    const relaxDelay = info.relaxDelaySeconds ?? 2 * 24 * 60 * 60;
    const upgradeDelay = info.upgradeDelaySeconds ?? relaxDelay;
    const adminDelay = info.adminDelaySeconds ?? upgradeDelay;

    upgrades.silenceWarnings();

    const ManagerFactory = await ethers.getContractFactory("EmergencyLevelManager", deployer);
    const manager = await upgrades.deployProxy(
        ManagerFactory,
        [
            accessManagerAddress,
            mzusdAddress,
            vaultAddress,
            reservoirAddress,
            lossManagerAddress,
            polJuniorAddress,
            trancheAddresses,
            0,
        ],
        {
            kind: "uups",
            initializer: "initialize",
        }
    );
    const managerTx = manager.deploymentTransaction();
    await manager.waitForDeployment();

    const managerAddress = await manager.getAddress();
    const managerImpl = await upgrades.erc1967.getImplementationAddress(managerAddress);

    console.log("EmergencyLevelManager proxy deployed at:", managerAddress);
    console.log("EmergencyLevelManager implementation:", managerImpl);

    recordDeployment(deployments, netName, "EmergencyLevelManager", {
        address: managerAddress,
        implementation: managerImpl,
        txHash: managerTx?.hash,
        deployedAt: new Date().toISOString(),
    });

    const ConfiguratorFactory = await ethers.getContractFactory(
        "AccessManagerConfiguratorV1",
        deployer
    );
    const configurator = await ConfiguratorFactory.deploy(deployer.address);
    const configuratorTx = configurator.deploymentTransaction();
    await configurator.waitForDeployment();

    const configuratorAddress = await configurator.getAddress();
    console.log("AccessManagerConfiguratorV1 deployed at:", configuratorAddress);

    recordDeployment(deployments, netName, "AccessManagerConfiguratorV1", {
        address: configuratorAddress,
        txHash: configuratorTx?.hash,
        deployedAt: new Date().toISOString(),
    });

    console.log("Granting ADMIN_ROLE to configurator...");
    const txGrantAdmin = await accessManager.grantRole(ADMIN_ROLE, configuratorAddress, 0);
    await txGrantAdmin.wait();

    console.log("Configuring AccessManager + applying L0 policy...");
    const txConfigure = await configurator.configure(
        accessManagerAddress,
        managerAddress,
        info.accessManagerAdmin,
        guardian,
        governor,
        mzusdAddress,
        vaultAddress,
        reservoirAddress,
        lossManagerAddress,
        trancheAddresses,
        relaxDelay,
        upgradeDelay,
        adminDelay
    );
    await txConfigure.wait();

    await verifyContract(managerImpl, []);
    await verifyContract(configuratorAddress, [deployer.address]);

    saveDeployments(deployments);
    console.log("Deployments file updated");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
