// Runtime schema for the environment-specific workflow JSON.
import {z} from "zod";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

export const configSchema = z.object({
    schedule: z.string().min(1),
    chainName: z.string().min(1),
    isTestnet: z.boolean(),
    gasLimit: z.string().regex(/^[1-9][0-9]*$/),
    vaults: z.array(
        z.object({
            id: z.string().min(1),
            issuanceVault: addressSchema,
            receiver: addressSchema.optional(),
            finalizers: z.array(
                z.object({tranche: z.enum(["senior", "junior"]), address: addressSchema})
            ),
        })
    ),
});

export type Config = z.infer<typeof configSchema>;
