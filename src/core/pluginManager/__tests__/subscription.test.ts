import { describe, expect, it } from "@jest/globals";
import {
    parseSubscribeEntries,
    planSubscribeEntries,
    type ISubscribeEntry,
} from "../subscription";

const baseUrl =
    "https://gh.padao.fun/https://raw.githubusercontent.com/x/y/master/sub/padao/main.json";
const pluginUrl =
    "https://gh.padao.fun/https://raw.githubusercontent.com/x/y/master/plugins/qq.js";

const entry = (
    name: string,
    version: string,
    url = pluginUrl,
): ISubscribeEntry => ({ name, version, url });

describe("parseSubscribeEntries", () => {
    it("标准结构 {plugins:[{name,version,url}]}", () => {
        expect(
            parseSubscribeEntries(
                JSON.stringify({
                    desc: "六平台",
                    plugins: [{ name: "QQ音乐", version: "1.9.26", url: pluginUrl }],
                }),
                baseUrl,
            ),
        ).toEqual([{ name: "QQ音乐", version: "1.9.26", url: pluginUrl }]);
    });

    it("顶层直接是数组", () => {
        expect(
            parseSubscribeEntries(JSON.stringify([{ url: pluginUrl }]), baseUrl),
        ).toEqual([{ name: "", version: "", url: pluginUrl }]);
    });

    it("兼容 downloadUrl / src / link 字段，且按优先级取 url", () => {
        expect(
            parseSubscribeEntries(
                [
                    { downloadUrl: pluginUrl },
                    { src: pluginUrl },
                    { link: pluginUrl },
                    { url: pluginUrl, downloadUrl: "https://a.com/ignored.js" },
                ],
                baseUrl,
            ).map(item => item.url),
        ).toEqual([pluginUrl, pluginUrl, pluginUrl, pluginUrl]);
    });

    it("相对地址按订阅地址解析", () => {
        expect(
            parseSubscribeEntries(
                { plugins: [{ url: "../../plugins/qq.js" }] },
                "https://raw.githubusercontent.com/x/y/master/sub/padao/main.json",
            )[0].url,
        ).toBe("https://raw.githubusercontent.com/x/y/master/plugins/qq.js");
    });

    it("非法 JSON 与缺字段条目返回空或过滤", () => {
        expect(parseSubscribeEntries("<html>proxy blocked</html>", baseUrl)).toEqual([]);
        expect(parseSubscribeEntries({ plugins: [{ name: "无地址" }] }, baseUrl)).toEqual([]);
        expect(parseSubscribeEntries(null, baseUrl)).toEqual([]);
        expect(parseSubscribeEntries({ desc: "没有 plugins 字段" }, baseUrl)).toEqual([]);
    });
});

describe("planSubscribeEntries", () => {
    it("同名且版本合法相等才跳过", () => {
        expect(
            planSubscribeEntries([entry("QQ音乐", "1.9.26")], [
                { name: "QQ音乐", version: "1.9.26" },
            ]),
        ).toEqual([{ action: "skip", name: "QQ音乐", url: pluginUrl }]);
    });

    it("版本不同则安装", () => {
        expect(
            planSubscribeEntries([entry("QQ音乐", "1.9.27")], [
                { name: "QQ音乐", version: "1.9.26" },
            ])[0].action,
        ).toBe("install");
    });

    it("订阅 name 与已装插件不同名则安装，即使版本相同", () => {
        expect(
            planSubscribeEntries([entry("QQ音乐", "1.9.26")], [
                { name: "qqmusic", version: "1.9.26" },
            ])[0].action,
        ).toBe("install");
    });

    it("任一侧 version 缺失或非法则安装，不能抛异常", () => {
        const installed = [
            { name: "A", version: "" },
            { name: "B" },
            { name: "C", version: "beta" },
        ];
        expect(
            planSubscribeEntries(
                [entry("A", "1.0.0"), entry("B", "1.0.0"), entry("C", "1.0.0")],
                installed,
            ).map(action => action.action),
        ).toEqual(["install", "install", "install"]);
    });
});
