// Runtime schema for the test-only NAV submitter workflow.
import {z} from "zod";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

export const configSchema = z.object({
    schedule: z.string().min(1),
    chainName: z.string().min(1),
    isTestnet: z.literal(true),
    gasLimit: z.string().regex(/^[1-9][0-9]*$/),
    vaults: z.array(
        z.object({
            id: z.string().min(1),
            submitter: addressSchema,
            receiver: addressSchema.optional(),
        })
    ),
});

export type Config = z.infer<typeof configSchema>;
