import { describe, expect, it, jest } from "@jest/globals";

/**
 * 取源编排（PluginMethodsWrapper.getMediaSource）的行为锁定测试。
 *
 * 这两条都是真机上踩过、修过的坑，回归代价极高（编 APK + 模拟器点歌），
 * 所以在这里用假插件代码把编排逻辑本身钉死：
 * 一、插件取不到链时是**抛错**而不是返回空——异常必须被收进 fetchSource 的
 *     try/catch，否则补 `_src` 重试永远走不到（备份恢复的歌全放不了就是这么来的）；
 * 二、彻底取不到时返回 null，并留下带定位信息的「取源失败」日志。
 *
 * 插件用假 CommonJS 字符串走真实的 mountPlugin 沙箱挂载，
 * 除插件解析外的原生依赖（文件系统 / MMKV / 原生桥）全部 mock 掉。
 */
jest.mock("@/constants/commonConst", () => ({
    internalSerializeKey: "$",
    localPluginPlatform: "本地",
    CacheControl: { Cache: "cache", NoCache: "no-cache", NoStore: "no-store" },
    emptyFunction: () => {},
}));
jest.mock("@/constants/pathConst", () => ({ __esModule: true, default: {} }));
jest.mock("@/native/mp3Util", () => ({ __esModule: true, default: {} }));
jest.mock("@/utils/log", () => ({
    devLog: jest.fn(),
    errorLog: jest.fn(),
    trace: jest.fn(),
}));
jest.mock("@/utils/delay", () => ({
    __esModule: true,
    default: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
}));
jest.mock("@/utils/network", () => ({
    __esModule: true,
    default: { isOffline: false },
}));
jest.mock("@/utils/mediaExtra", () => ({
    getMediaExtraProperty: jest.fn(() => undefined),
    patchMediaExtra: jest.fn(),
}));
jest.mock("@/utils/fileUtils", () => ({
    addFileScheme: (p: string) =>
        p.startsWith("file://") ? p : `file://${p}`,
    getFileName: (p: string) => p.split("/").pop(),
}));
jest.mock("@/core/mediaCache", () => ({
    __esModule: true,
    default: {
        getMediaCache: jest.fn(() => null),
        setMediaCache: jest.fn(),
    },
}));
jest.mock("@/core/pluginManager/meta", () => ({
    __esModule: true,
    default: {
        getPluginAlias: jest.fn(() => ""),
        getPluginMatchNames: jest.fn(() => []),
        getUserVariables: jest.fn(() => ({})),
    },
}));
jest.mock("react-native-fs", () => ({
    __esModule: true,
    default: {},
    exists: jest.fn(async () => false),
    readFile: jest.fn(),
    stat: jest.fn(),
    writeFile: jest.fn(),
}));
jest.mock("react-native-device-info", () => ({
    __esModule: true,
    default: { getVersion: () => "999.0.0" },
}));

import { errorLog } from "@/utils/log";
import { Plugin } from "../plugin";

const mockedErrorLog = errorLog as jest.MockedFunction<typeof errorLog>;

/** 备份恢复出来的老曲目：platform 是旧写法、没有 `_src` */
const legacyItem = () => ({
    id: "qq_123",
    platform: "QQ音乐",
    title: "爸爸妈妈",
    artist: "王蓉",
    duration: 240,
});

const REAL_URL = "https://example.com/real.m4a";

/** 像那套聚合插件一样：缺 `_src` 就 throw，而不是返回 null */
const throwWhenNoSrc = `
module.exports = {
    platform: "qq",
    name: "QQ音乐",
    async getMediaSource(mediaItem) {
        if (!mediaItem._src || !mediaItem._src.qq || !mediaItem._src.qq.mediaMid) {
            throw new Error("聚合取链失败");
        }
        return { url: "${REAL_URL}" };
    },
    async getMusicInfo() {
        return { _src: { qq: { mediaMid: "003abc" } } };
    },
    async search() { return { data: [] }; },
};
`;

describe("getMediaSource：插件抛错也要补 _src 重试", () => {
    it("getMediaSource 抛错 → getMusicInfo 补回 _src → 重试成功", async () => {
        const plugin = new Plugin(throwWhenNoSrc, "/fake/qq.js");
        expect(plugin.name).toBe("qq");

        const source = await plugin.methods.getMediaSource!(
            legacyItem() as any,
            "standard",
        );

        expect(source?.url).toBe(REAL_URL);
        expect(mockedErrorLog).not.toHaveBeenCalledWith(
            "取源失败",
            expect.anything(),
        );
    });

    it("详情接口不补 _src 时，退到搜索按 id（剥平台前缀）重建", async () => {
        const code = `
module.exports = {
    platform: "qq",
    async getMediaSource(mediaItem) {
        if (!mediaItem._src) {
            throw new Error("聚合取链失败");
        }
        return { url: "${REAL_URL}" };
    },
    async search() {
        return {
            data: [
                { id: "123", title: "爸爸妈妈", artist: "王蓉", _src: { qq: { mediaMid: "003abc" } } },
            ],
        };
    },
};
`;
        const plugin = new Plugin(code, "/fake/qq2.js");

        const source = await plugin.methods.getMediaSource!(
            legacyItem() as any,
            "standard",
        );

        expect(source?.url).toBe(REAL_URL);
    });
});

describe("getMediaSource：彻底取不到时", () => {
    it("返回 null 并留下「取源失败」日志（recovered:false）", async () => {
        mockedErrorLog.mockClear();
        const code = `
module.exports = {
    platform: "qq",
    async getMediaSource() {
        throw new Error("聚合取链失败");
    },
    async getMusicInfo() {
        throw new Error("详情接口挂了");
    },
    async search() { return { data: [] }; },
};
`;
        const plugin = new Plugin(code, "/fake/qq3.js");

        const source = await plugin.methods.getMediaSource!(
            legacyItem() as any,
            "standard",
        );

        expect(source).toBeNull();
        expect(mockedErrorLog).toHaveBeenCalledWith(
            "取源失败",
            expect.objectContaining({
                platform: "qq",
                id: "qq_123",
                title: "爸爸妈妈",
                recovered: false,
            }),
        );
    });
});
