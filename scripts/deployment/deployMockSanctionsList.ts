import {ethers, network} from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();

    console.log("Network:", network.name);
    console.log("Deployer:", deployer.address);

    console.log("=== Deploy MockSanctionsList ===");
    const Factory = await ethers.getContractFactory("MockSanctionsList", deployer);
    const mockSanctionsList = await Factory.deploy();
    await mockSanctionsList.waitForDeployment();

    const address = await mockSanctionsList.getAddress();
    const txHash = mockSanctionsList.deploymentTransaction()?.hash;

    console.log("MockSanctionsList deployed at:", address);
    console.log("Deployment tx:", txHash);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
