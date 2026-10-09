import fs from "fs";
import path from "path";

type ConfigObject = Record<string, unknown>;

function isObject(value: unknown): value is ConfigObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Objects inherit individual fields; arrays (tranches, roles, seeding) replace in full.
export function mergeConfig(base: ConfigObject, override: ConfigObject): ConfigObject {
    const result = {...base};
    for (const [key, value] of Object.entries(override)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) {
            throw new Error(`Invalid configuration key: ${key}`);
        }
        result[key] = isObject(value)
            ? mergeConfig(isObject(base[key]) ? base[key] : {}, value)
            : value;
    }
    return result;
}

export function readConfigProfile(filePath: string, ancestors: string[] = []): ConfigObject {
    const resolved = fs.realpathSync(filePath);
    if (ancestors.includes(resolved)) {
        throw new Error(`Circular config inheritance: ${[...ancestors, resolved].join(" -> ")}`);
    }
    const raw: unknown = JSON.parse(fs.readFileSync(resolved, "utf8"));
    if (!isObject(raw)) throw new Error(`Config must be an object: ${resolved}`);
    const {extends: parent, ...own} = raw;
    if (parent === undefined) return mergeConfig({}, own);
    if (typeof parent !== "string" || !parent.trim()) {
        throw new Error(`extends must be a non-empty relative file path: ${resolved}`);
    }
    const base = readConfigProfile(path.resolve(path.dirname(resolved), parent), [
        ...ancestors,
        resolved,
    ]);
    return mergeConfig(base, own);
}
