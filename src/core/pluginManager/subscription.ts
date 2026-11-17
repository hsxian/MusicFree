import { compare, validate } from "compare-versions";
import { URL } from "react-native-url-polyfill";
import { safeParse } from "../../utils/jsonUtil";

/**
 * 订阅地址内容 → 待安装条目 的纯逻辑。
 * 不管的事：网络请求（fetchText）、插件解析与落盘（PluginManager）。
 */

export interface ISubscribeEntry {
    name: string;
    version: string;
    url: string;
}

export interface IInstalledBrief {
    name: string;
    version?: string;
}

export type TSubscribeAction =
    | { action: "install"; name: string; url: string }
    | { action: "skip"; name: string; url: string };

/** 各家订阅源的字段名不统一，按优先级取第一个非空字符串 */
const urlFields = ["url", "downloadUrl", "src", "link"] as const;

function resolveUrl(rawUrl: string, baseUrl: string): string {
    try {
        return new URL(rawUrl, baseUrl).toString();
    } catch {
        return rawUrl;
    }
}

const asText = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";

/**
 * 归一订阅内容，兼容「条目数组」与「{plugins:[...]}」两种顶层结构。
 * 无法识别时返回空数组，由调用方如实提示，而不是假装成功。
 */
export function parseSubscribeEntries(
    raw: string | unknown,
    baseUrl: string,
): ISubscribeEntry[] {
    const parsed = typeof raw === "string" ? safeParse(raw) : raw;
    const rawItems: unknown = Array.isArray(parsed)
        ? parsed
        : (parsed as any)?.plugins;
    if (!Array.isArray(rawItems)) {
        return [];
    }
    const entries: ISubscribeEntry[] = [];
    for (const rawItem of rawItems) {
        const item = rawItem as Record<string, unknown>;
        const urlField = urlFields.find(field => !!asText(item?.[field]));
        if (!urlField) {
            continue;
        }
        entries.push({
            name: asText(item?.name),
            version: asText(item?.version),
            url: resolveUrl(asText(item[urlField]), baseUrl),
        });
    }
    return entries;
}

/**
 * 决定每个条目是下载还是跳过。
 * 跳过只在订阅 name 与已装插件 name 精确相等、且两侧版本都是合法 semver 且相等时成立；
 * 订阅源常把 name 写成中文展示名而与插件 platform 不同名，此时宁可多下一遍（安装侧还有 hash 去重）也不能漏更。
 */
export function planSubscribeEntries(
    entries: ISubscribeEntry[],
    installedPlugins: IInstalledBrief[],
): TSubscribeAction[] {
    return entries.map(entry => {
        const installed = installedPlugins.find(
            plugin => plugin.name && plugin.name === entry.name,
        );
        if (
            installed &&
            validate(entry.version) &&
            validate(installed.version ?? "") &&
            compare(entry.version, installed.version!, "=")
        ) {
            return { action: "skip", name: entry.name, url: entry.url };
        }
        return { action: "install", name: entry.name, url: entry.url };
    });
}
