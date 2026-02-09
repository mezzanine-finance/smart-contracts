# Protocol Diagrams (WIP)

This file is the home for system and flow diagrams.

## System context

```mermaid
%%{init: {'flowchart': {'nodeSpacing': 90, 'rankSpacing': 120}}}%%
flowchart TB
  subgraph Actors
    direction LR
    User[User]
    Oracle[Oracle]
    Automation[Automation]
    Admin[Admin]
  end

  subgraph CoreContracts["Core contracts"]
    direction LR
    MZUSD[MZUSD]
    Vault[Vault]
    Tranches["Tranche(s)"]
    PolJunior[POL Junior Tranche]
    Reservoir[ReservoirUSDC]
    LossManager[LossManager]
    NavAuto[NavOracleAutomation]
  end

  subgraph Governance
    direction LR
    Access["AccessManager<br/>access control"]
    Pause["PauseManager<br/>pause gates"]
  end

  User -->|mint/redeem<br/>MZUSD| MZUSD
  User -->|deposit/withdraw<br/>tranches| Tranches
  Oracle -->|post NAV<br/>snapshots| NavAuto
  Automation -->|execute<br/>upkeep| NavAuto
  NavAuto -->|route yield<br/>to Vault| Vault
  NavAuto -->|route loss<br/>to LossManager| LossManager
  LossManager -->|advance epoch| Vault
  Vault -->|mint MZUSD<br/>for yield| MZUSD
  MZUSD -->|redeem USDC<br/>via Vault| Vault
  Vault -->|send yield<br/>to tranches| Tranches
  Vault -->|send yield<br/>to POL tranche| PolJunior
  LossManager -->|instruct burns<br/>by order/pairs| Tranches
  Tranches -->|burn own MZUSD<br/>on losses| MZUSD
  Vault <--> |rebalance USDC| Reservoir
  Admin -->|configure<br/>access rules| Access
  Admin -->|toggle safety<br/>pauses| Pause
  Access -.->|access| Vault
  Access -.->|access| Tranches
  Access -.->|access| MZUSD
  Access -.->|access| LossManager
  Access -.->|access| Reservoir
  Pause -.->|pause| Vault
  Pause -.->|pause| Tranches
  Pause -.->|pause| MZUSD
  Pause -.->|pause| LossManager
  Pause -.->|pause| Reservoir
```

## Token movement (funds flow)

```mermaid
%%{init: {'flowchart': {'nodeSpacing': 90, 'rankSpacing': 110}}}%%
flowchart TB
  User[User]

  subgraph MintRedeem["Mint and redeem"]
    direction TB
    MZUSD[MZUSD]
    Vault[Vault]
    Reservoir[ReservoirUSDC]
  end

  subgraph TrancheFlow["Tranche deposits"]
    direction TB
    Tranches["Tranche(s)"]
    TrancheShares["Tranche token (shares)"]
  end

  subgraph YieldLoss["Yield and loss"]
    direction TB
    FeeReceivers[Fee receivers]
    LossManager[LossManager]
  end

  subgraph Targets["Targets and policies"]
    direction TB
    VaultTarget["Vault idle buffer target:<br/>1,000,000 USDC"]
    ReservoirTarget["Reservoir target:<br/>~5% of TVL/NAV"]
  end

  User -->|USDC deposit| MZUSD
  MZUSD -->|USDC transfer| Vault
  Vault -->|USDC redemption| User
  Vault <--> |USDC rebalance| Reservoir

  MZUSD -->|MZUSD mint| User
  User -->|MZUSD deposit| Tranches
  Tranches -->|mint tranche<br/>shares| TrancheShares
  TrancheShares -->|tranche token minted to user| User
  User -->|burn tranche<br/>token| TrancheShares
  Tranches -->|MZUSD withdraw/<br/>claim| User

  Vault -->|MZUSD yield<br/>allocation| Tranches
  Vault -->|MZUSD protocol/<br/>perf fees| FeeReceivers
  LossManager -->|loss instructions<br/>to tranches| Tranches
  Tranches -->|MZUSD burn<br/>from tranche balances| MZUSD

  Vault -.->|buffer policy| VaultTarget
  Reservoir -.->|liquidity target| ReservoirTarget
```

## MZUSD mint and redeem

```mermaid
sequenceDiagram
  participant User
  participant MZUSD
  participant USDC
  participant Vault
  participant Reservoir

  alt User deposits USDC
    User->>MZUSD: Deposit USDC
    MZUSD->>USDC: Transfer USDC to Vault
    MZUSD->>MZUSD: Mint MZUSD to user
    MZUSD-->>User: Deposit confirmed
  else User redeems MZUSD
    User->>MZUSD: Request withdrawal
    MZUSD->>MZUSD: Burn MZUSD
    MZUSD->>Vault: Request USDC payout
    alt Vault short on USDC
      Vault->>Reservoir: Pull USDC liquidity
    end
    Vault->>USDC: Transfer USDC to user
    MZUSD-->>User: Withdrawal confirmed
  end
```

## Yield distribution (NAV > supply)

```mermaid
sequenceDiagram
  participant Oracle
  participant Automation
  participant NavAuto as NavOracleAutomation
  participant Vault
  participant MZUSD
  participant Tranche
  participant FeeReceivers

  Oracle->>NavAuto: Submit NAV
  NavAuto->>NavAuto: Store NAV and supply snapshot
  Automation->>NavAuto: Run upkeep
  NavAuto->>Vault: Distribute yield
  Vault->>Vault: Advance epoch
  Vault->>MZUSD: Mint fees
  MZUSD-->>FeeReceivers: Send fee tokens
  Vault->>MZUSD: Mint yield for allocation
  loop each enabled tranche
    Vault->>Tranche: Send MZUSD and notify yield
    Tranche->>Tranche: Start yield stream
  end
```

## Loss application (NAV < supply)

```mermaid
sequenceDiagram
  participant Oracle
  participant Automation
  participant NavAuto as NavOracleAutomation
  participant Vault
  participant LossManager
  participant MZUSD
  participant Tranche

  Oracle->>NavAuto: Submit NAV
  NavAuto->>NavAuto: Store NAV and supply snapshot
  Automation->>NavAuto: Run upkeep
  NavAuto->>LossManager: Apply loss
  LossManager->>Vault: Advance epoch
  loop tranche order / pairs
    LossManager->>Tranche: Request tranche burn
    Tranche->>MZUSD: Burn tranche-held MZUSD
  end
```

## Umbrella withdrawal (direct mode disabled)

```mermaid
sequenceDiagram
  participant User
  participant Operator
  participant Tranche
  participant Vault

  User->>Tranche: Request withdrawal (shares)
  Tranche->>Vault: Read current epoch
  Tranche->>Tranche: Record target epoch and hold shares
  Note over Tranche: Wait for target epoch
  Operator->>Tranche: Finalize epoch
  Tranche->>Vault: Read current epoch
  Tranche->>Tranche: Compute assets and burn shares
  User->>Tranche: Claim assets
  Tranche-->>User: Transfer MZUSD
```

## Rebalancing buffer and Reservoir

```mermaid
sequenceDiagram
  participant Keeper
  participant Vault
  participant Reservoir
  participant USDC

  Keeper->>Vault: Rebalance buffer
  Vault->>Vault: Read idle balance and bounds
  alt idle above upper bound
    Vault->>USDC: Approve Reservoir
    Vault->>Reservoir: Deposit excess USDC
  else idle below lower bound
    Vault->>Reservoir: Withdraw USDC to Vault
  else within band
    Vault->>Vault: No action
  end
  Vault-->>Keeper: Rebalanced event
```
