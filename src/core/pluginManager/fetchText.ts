import axios from "axios";

/**
 * 插件相关的「取文本」收口：订阅 JSON 与插件文件下载共用。
 * 不管的事：插件内部的网络请求（那些仍走 plugin.ts 里 axios 的全局 defaults，超时语义属于插件自己）。
 */

/**
 * 插件文件普遍几百 KB（实测 497KB / 613KB），经国内代理实测 2.0~2.4s，
 * 而全局 defaults 是 2000ms，几乎必然掐断。下载类请求单独放宽。
 */
const downloadTimeout = 30_000;

const noCacheHeaders = {
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Expires: "0",
};

export async function fetchPluginText(url: string): Promise<string> {
    const res = await axios.get<string>(url, {
        timeout: downloadTimeout,
        headers: noCacheHeaders,
        /** 订阅 JSON 也要拿原文交给 safeParse，不能让 axios 按 Content-Type 自行反序列化 */
        responseType: "text",
        transformResponse: [(it: unknown) => it],
    });
    return typeof res.data === "string" ? res.data : String(res.data);
}
