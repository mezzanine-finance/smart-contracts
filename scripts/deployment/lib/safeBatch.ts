import fs from "fs";
import path from "path";

export interface SafeBatchTransaction {
    to: string;
    value: string;
    data: string;
    contractMethod: null;
    contractInputsValues: null;
}

export class SafeBatchBuilder {
    private readonly transactions: SafeBatchTransaction[] = [];

    constructor(
        private readonly chainId: string,
        private readonly safeAddress: string,
        private readonly name: string,
        private readonly description: string
    ) {}

    add(to: string, data: string) {
        this.transactions.push({
            to,
            value: "0",
            data,
            contractMethod: null,
            contractInputsValues: null,
        });
    }

    get length() {
        return this.transactions.length;
    }

    write(filePath: string) {
        const absolutePath = path.resolve(filePath);
        fs.mkdirSync(path.dirname(absolutePath), {recursive: true});
        fs.writeFileSync(
            absolutePath,
            JSON.stringify(
                {
                    version: "1.0",
                    chainId: this.chainId,
                    createdAt: Date.now(),
                    meta: {
                        name: this.name,
                        description: this.description,
                        txBuilderVersion: "1.18.0",
                        createdFromSafeAddress: this.safeAddress,
                        createdFromOwnerAddress: "",
                        checksum: "",
                    },
                    transactions: this.transactions,
                },
                null,
                2
            )
        );
        return absolutePath;
    }
}
