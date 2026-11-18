import { describe, expect, it, jest, beforeEach } from "@jest/globals";

/**
 * 锁一个真机 bug：熄屏进 Doze 后网络被掐但不报错，
 * 「整曲下完再播」的 await 永远不返回 → 新歌/缓存播/自动连播全部卡死，
 * 用户按蓝牙线控唤醒手机才恢复。看门狗必须在下载停滞时放弃缓存、回退远程源。
 */
const mockStoreData = new Map<string, string>();
jest.mock("@/utils/getOrCreateMMKV", () => () => ({
    getString: (k: string) => mockStoreData.get(k),
    set: (k: string, v: string) => void mockStoreData.set(k, v),
    delete: (k: string) => void mockStoreData.delete(k),
    getAllKeys: () => [...mockStoreData.keys()],
    clearAll: () => mockStoreData.clear(),
}));
jest.mock("@/constants/commonConst", () => ({
    emptyFunction: () => {},
    localPluginPlatform: "本地",
    supportLocalMediaType: [".mp3", ".flac", ".m4a"],
}));
jest.mock("@/constants/pathConst", () => ({
    __esModule: true,
    default: { playCachePath: "/cache/" },
}));
jest.mock("@/core/appConfig", () => ({
    __esModule: true,
    default: {
        getConfig: (key: string) =>
            key === "basic.maxCacheSize" ? 1024 * 1024 * 1024 * 1024 : undefined,
    },
}));
jest.mock("@/utils/toast", () => ({
    __esModule: true,
    default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));
jest.mock("@/utils/fileUtils", () => ({
    addFileScheme: (p: string) => `file://${p}`,
    escapeCharacter: (s: string) => s,
    mkdirR: async () => {},
}));
jest.mock("@/utils/log", () => ({ errorLog: jest.fn() }));
jest.mock("@/utils/network", () => ({
    __esModule: true,
    default: { isOffline: false },
}));
jest.mock("react-native", () => ({
    Platform: { OS: "android" },
    NativeModules: {
        CacheKeepAlive: { start: jest.fn(async () => true), stop: jest.fn() },
    },
}));

let mockCapturedOptions: any = null;
const mockCancel = jest.fn();
let mockSettleTask: (r: any) => void = () => {};
jest.mock("react-native-fs", () => ({
    __esModule: true,
    default: {},
    exists: jest.fn(async () => false),
    copyFile: jest.fn(async () => {}),
    unlink: jest.fn(async () => {}),
    mkdir: jest.fn(async () => {}),
    downloadFile: jest.fn((options: any) => {
        mockCapturedOptions = options;
        let rejectTask: (e: any) => void = () => {};
        const promise = new Promise((resolve, reject) => {
            mockSettleTask = resolve as any;
            rejectTask = reject;
        });
        (promise as any).cancel = mockCancel;
        mockCancel.mockImplementation(() => rejectTask(new Error("CANCELLED")));
        return { promise };
    }),
}));

import { cacheMusic } from "../playCache";

const musicItem = {
    id: "a1",
    platform: "qq",
    title: "t",
} as IMusic.IMusicItem;

beforeEach(() => {
    jest.useFakeTimers();
    mockStoreData.clear();
    mockCapturedOptions = null;
    mockCancel.mockClear();
});

describe("cacheMusic 下载停滞看门狗", () => {
    it("下载完全不进账（Doze 掐网）：停滞超时后取消下载并回退 null", async () => {
        const p = cacheMusic(musicItem, "standard", {
            url: "https://example.com/song.mp3",
        });
        // 放行 mkdir / keepAlive 等微任务，让下载与看门狗跑起来
        await jest.advanceTimersByTimeAsync(1000);
        expect(mockCapturedOptions.progressCallback).toBeDefined();

        await jest.advanceTimersByTimeAsync(12_000);

        await expect(p).resolves.toBeNull();
        expect(mockCancel).toHaveBeenCalled();
    });

    it("下载正常推进：不被看门狗误杀，完成后返回本地源", async () => {
        const p = cacheMusic(musicItem, "standard", {
            url: "https://example.com/song.mp3",
        });
        await jest.advanceTimersByTimeAsync(1000);

        // 每 2 秒有字节进账，累计推进 8 秒——都低于停滞阈值
        for (const bytes of [500, 1000]) {
            await jest.advanceTimersByTimeAsync(4000);
            mockCapturedOptions.progressCallback({ bytesWritten: bytes });
        }
        expect(mockCancel).not.toHaveBeenCalled();

        mockSettleTask({ statusCode: 200, bytesWritten: 1000 });
        await expect(p).resolves.toEqual({
            url: "file:///cache/qq@a1@standard.mp3",
        });
    });
});
