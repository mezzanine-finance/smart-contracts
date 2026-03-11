import {ethers, network} from "hardhat";
import {getArg, hasFlag, isLocalNetwork} from "./helpers";
import {loadConfig} from "./config";
import {getLatestDeployment, loadDeployments} from "./deployments";
import {ensureRoleMember} from "./roles";
import {log} from "./logger";

interface RoleCheck {
    name: string;
    roleId: number;
    members: string[];
}

function uniqueAddresses(addresses: string[]): string[] {
    const seen = new Map<string, string>();
    for (const addr of addresses) {
        const key = addr.toLowerCase();
        if (!seen.has(key)) {
            seen.set(key, addr);
        }
    }
    return Array.from(seen.values());
}

export async function grantRoles() {
    const configPath = getArg("--config");
    const includeDev = hasFlag("--include-dev");
    const config = loadConfig(network.name, configPath);
    const deployments = loadDeployments();

    const accessManagerDeployment = getLatestDeployment(deployments, network.name, "AccessManager");
    if (!accessManagerDeployment) {
        throw new Error("AccessManager deployment not found for this network");
    }

    const vaultDeployment = getLatestDeployment(deployments, network.name, "IssuanceVault");
    if (!vaultDeployment) {
        throw new Error("IssuanceVault deployment not found for this network");
    }
    const trancheDeployments = config.tranches.map((tranche) => {
        const deployment = getLatestDeployment(deployments, network.name, `Tranche.${tranche.key}`);
        if (!deployment) {
            throw new Error(`Tranche deployment not found for key: ${tranche.key}`);
        }
        return deployment.address;
    });
    const burnerTargets = [...trancheDeployments];

    const accessManager = await ethers.getContractAt(
        "AccessManager",
        accessManagerDeployment.address
    );

    const [signer] = await ethers.getSigners();
    const signerAddress = await signer.getAddress();

    log.step("Grant roles preflight");
    log.info(`Network: ${network.name}`);
    log.info(`Signer: ${signerAddress}`);
    log.info(`Final admin: ${config.roles.admin}`);
    log.info(`Include dev: ${includeDev}`);
    log.info(`Config: ${configPath ?? `scripts/deployment/config/${network.name}.json`}`);
    if (isLocalNetwork(network.name)) {
        log.warn("Granting roles on a local network is usually unnecessary.");
    }

    const adminRole = Number(await accessManager.ADMIN_ROLE());
    const [hasAdmin] = await accessManager.hasRole(adminRole, signerAddress);
    if (!hasAdmin) {
        throw new Error("Signer must hold ADMIN_ROLE to grant roles");
    }

    await ensureRoleMember(accessManager, adminRole, config.roles.admin, 0);
    if (includeDev && config.roles.admin.toLowerCase() !== config.dev.deployer.toLowerCase()) {
        await ensureRoleMember(accessManager, adminRole, config.dev.deployer, 0);
    }

    const delays = config.roles.roleDelays ?? {};

    const pausers = uniqueAddresses([
        config.roles.pauser,
        ...(includeDev ? [config.dev.deployer] : []),
    ]);
    for (const addr of pausers) {
        await ensureRoleMember(accessManager, config.roleIds.PAUSER_ROLE, addr, delays.pauser ?? 0);
    }

    const unpausers = uniqueAddresses([
        config.roles.unpauser,
        ...(includeDev ? [config.dev.deployer] : []),
    ]);
    for (const addr of unpausers) {
        await ensureRoleMember(
            accessManager,
            config.roleIds.UNPAUSER_ROLE,
            addr,
            delays.unpauser ?? 0
        );
    }

    const upgraders = uniqueAddresses([
        config.roles.upgrader,
        ...(includeDev ? [config.dev.deployer] : []),
    ]);
    for (const addr of upgraders) {
        await ensureRoleMember(
            accessManager,
            config.roleIds.UPGRADER_ROLE,
            addr,
            delays.upgrader ?? 0
        );
    }

    const withdrawers = uniqueAddresses([
        config.roles.admin,
        ...(config.roles.reservoirWithdrawers ?? []),
        vaultDeployment.address,
        ...(includeDev ? [config.dev.deployer] : []),
    ]);
    for (const addr of withdrawers) {
        await ensureRoleMember(
            accessManager,
            config.roleIds.RESERVOIR_WITHDRAW_ROLE,
            addr,
            delays.reservoirWithdraw ?? 0
        );
    }

    const keepers = uniqueAddresses([
        ...(config.roles.keepers ?? []),
        ...(includeDev ? [config.dev.deployer] : []),
    ]);
    for (const addr of keepers) {
        await ensureRoleMember(accessManager, config.roleIds.KEEPER_ROLE, addr, delays.keeper ?? 0);
    }

    const oracles = uniqueAddresses([
        ...config.navOracle.oracles,
        ...(includeDev ? [config.dev.deployer] : []),
    ]);
    for (const addr of oracles) {
        await ensureRoleMember(accessManager, config.roleIds.ORACLE_ROLE, addr, delays.oracle ?? 0);
    }

    for (const addr of uniqueAddresses(burnerTargets)) {
        await ensureRoleMember(accessManager, config.roleIds.BURNER_ROLE, addr, delays.burner ?? 0);
    }

    const allowlisters = uniqueAddresses([
        ...(config.roles.allowlisters ?? []),
        ...(includeDev ? [config.dev.deployer] : []),
    ]);
    for (const addr of allowlisters) {
        await ensureRoleMember(
            accessManager,
            config.roleIds.ALLOWLISTER_ROLE,
            addr,
            delays.allowlister ?? 0
        );
    }

    log.success("Role grants complete");
}

export async function renounceRoles() {
    const configPath = getArg("--config");
    const config = loadConfig(network.name, configPath);
    const deployments = loadDeployments();

    const accessManagerDeployment = getLatestDeployment(deployments, network.name, "AccessManager");
    if (!accessManagerDeployment) {
        throw new Error("AccessManager deployment not found for this network");
    }

    const vaultDeployment = getLatestDeployment(deployments, network.name, "IssuanceVault");
    if (!vaultDeployment) {
        throw new Error("IssuanceVault deployment not found for this network");
    }
    const trancheDeployments = config.tranches.map((tranche) => {
        const deployment = getLatestDeployment(deployments, network.name, `Tranche.${tranche.key}`);
        if (!deployment) {
            throw new Error(`Tranche deployment not found for key: ${tranche.key}`);
        }
        return deployment.address;
    });
    const burnerMembers = [...trancheDeployments];

    const accessManager = await ethers.getContractAt(
        "AccessManager",
        accessManagerDeployment.address
    );
    const [deployer] = await ethers.getSigners();
    const deployerAddress = await deployer.getAddress();

    log.step("Renounce roles preflight");
    log.info(`Network: ${network.name}`);
    log.info(`Deployer: ${deployerAddress}`);
    if (isLocalNetwork(network.name)) {
        log.warn("Renouncing roles on a local network is usually unnecessary.");
    }

    const adminRole = Number(await accessManager.ADMIN_ROLE());
    const roleIds = config.roleIds;
    const roleChecks: RoleCheck[] = [
        {name: "ADMIN_ROLE", roleId: adminRole, members: [config.roles.admin]},
        {name: "PAUSER_ROLE", roleId: roleIds.PAUSER_ROLE, members: [config.roles.pauser]},
        {name: "UNPAUSER_ROLE", roleId: roleIds.UNPAUSER_ROLE, members: [config.roles.unpauser]},
        {name: "UPGRADER_ROLE", roleId: roleIds.UPGRADER_ROLE, members: [config.roles.upgrader]},
        {
            name: "RESERVOIR_WITHDRAW_ROLE",
            roleId: roleIds.RESERVOIR_WITHDRAW_ROLE,
            members: [
                config.roles.admin,
                ...(config.roles.reservoirWithdrawers ?? []),
                vaultDeployment.address,
            ],
        },
        {
            name: "KEEPER_ROLE",
            roleId: roleIds.KEEPER_ROLE,
            members: config.roles.keepers ?? [],
        },
        {
            name: "ORACLE_ROLE",
            roleId: roleIds.ORACLE_ROLE,
            members: config.navOracle.oracles,
        },
        {
            name: "BURNER_ROLE",
            roleId: roleIds.BURNER_ROLE,
            members: burnerMembers,
        },
        {
            name: "ALLOWLISTER_ROLE",
            roleId: roleIds.ALLOWLISTER_ROLE,
            members: config.roles.allowlisters ?? [],
        },
    ];

    for (const role of roleChecks) {
        const [hasRole] = await accessManager.hasRole(role.roleId, deployerAddress);
        if (!hasRole) {
            log.info(`Deployer does not hold ${role.name}, skipping`);
            continue;
        }

        const otherMembers = role.members.filter(
            (addr) => addr.toLowerCase() !== deployerAddress.toLowerCase()
        );
        let hasOther = false;
        for (const addr of otherMembers) {
            const [member] = await accessManager.hasRole(role.roleId, addr);
            if (member) {
                hasOther = true;
                break;
            }
        }

        if (!hasOther) {
            throw new Error(
                `Refusing to renounce ${role.name}: no other active members besides deployer`
            );
        }

        log.info(`Renouncing ${role.name}`);
        const tx = await accessManager.renounceRole(role.roleId, deployerAddress);
        await tx.wait();
        log.success(`Renounced ${role.name}`);
    }

    log.success("Role renounce flow complete");
}
