import {formatEther, formatUnits, Signer, TransactionReceipt} from "ethers";
import {log} from "./logger";

interface TxRecord {
    hash: string;
    gasUsed: bigint;
    fee: bigint;
}

export class GasTracker {
    private records: TxRecord[] = [];
    private seen = new Set<string>();
    private pending: Promise<void>[] = [];

    private track(receipt: TransactionReceipt | null): void {
        if (!receipt || this.seen.has(receipt.hash)) return;
        this.seen.add(receipt.hash);
        this.records.push({
            hash: receipt.hash,
            gasUsed: receipt.gasUsed,
            fee: receipt.fee,
        });
    }

    wrapSigner<T extends Signer>(signer: T): T {
        const original = signer.sendTransaction.bind(signer);
        (signer as any).sendTransaction = async (tx: any) => {
            const response = await original(tx);
            this.pending.push(response.wait().then((r: any) => this.track(r)));
            return response;
        };
        return signer;
    }

    async printSummary(): Promise<void> {
        await Promise.all(this.pending);

        const totalGas = this.records.reduce((sum, r) => sum + r.gasUsed, 0n);
        const totalFee = this.records.reduce((sum, r) => sum + r.fee, 0n);

        log.step("Gas summary");
        log.info(`Transactions: ${this.records.length}`);
        log.info(`Total gas used: ${totalGas.toLocaleString()}`);
        log.info(`Total ETH spent: ${formatEther(totalFee)} ETH`);
        if (totalFee > 0n && totalGas > 0n) {
            const avgGasPrice = totalFee / totalGas;
            log.info(`Average gas price: ${formatUnits(avgGasPrice, "gwei")} gwei`);
        }
    }
}
