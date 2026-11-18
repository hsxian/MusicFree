import { describe, expect, it } from "@jest/globals";
import {
    canonicalPlatform,
    findPluginByPlatform,
    invalidatePlatformCache,
    isPluginOfPlatform,
    setPlatformCandidatesProvider,
} from "../platformMatch";

/** 真实场景：插件主键是 qq，用户给它起了个显示名「腾讯音乐」，匹配名里留着换插件前用过的「QQ音乐」 */
const qqPlugin = {
    name: "qq",
    displayName: "腾讯音乐",
    matchNames: ["QQ音乐"],
};
const neteasePlugin = {
    name: "netease",
    displayName: "netease",
    matchNames: [],
};
const plugins = [qqPlugin, neteasePlugin];

describe("findPluginByPlatform", () => {
    it("按主键命中", () => {
        expect(findPluginByPlatform("qq", plugins)).toBe(qqPlugin);
    });

    it("按匹配名命中：换插件之前收藏的那些曲目还得能播", () => {
        expect(findPluginByPlatform("QQ音乐", plugins)).toBe(qqPlugin);
    });

    it("显示名只用于展示，不参与解析", () => {
        expect(findPluginByPlatform("腾讯音乐", plugins)).toBeUndefined();
    });

    it("真实主键优先于同名匹配名，结果不随插件顺序漂", () => {
        /** 有人把匹配名起成了另一个插件的主键，那种曲目应归真实主键那个插件 */
        const conflicted = [qqPlugin, { name: "QQ音乐", displayName: "QQ音乐", matchNames: [] }];

        expect(findPluginByPlatform("QQ音乐", conflicted)).toBe(conflicted[1]);
        expect(findPluginByPlatform("QQ音乐", [conflicted[1], qqPlugin])).toBe(
            conflicted[1],
        );
    });

    it("认不出的平台名返回 undefined，不做任何猜测", () => {
        expect(findPluginByPlatform("酷狗音乐", plugins)).toBeUndefined();
        expect(findPluginByPlatform("", plugins)).toBeUndefined();
    });

    /**
     * 榜单/推荐歌单/专辑详情这批接口旧版不做 platform 归一，曲目里存的是插件内部标识（qq）。
     * 不认这个值，那批老曲目一律找不到插件，点歌即失败。
     */
    it("认插件内部平台标识：曲目里存的是 qq 也要能找到「QQ音乐」这个插件", () => {
        const chineseName = {
            name: "QQ音乐",
            displayName: "QQ音乐",
            matchNames: [],
            channel: "qq",
        };

        expect(findPluginByPlatform("qq", [chineseName])).toBe(chineseName);
        /** 主键仍然优先：插件真叫 qq 时不该被 channel 抢走 */
        expect(findPluginByPlatform("qq", [chineseName, qqPlugin])).toBe(
            qqPlugin,
        );
        expect(findPluginByPlatform("", [chineseName])).toBeUndefined();
    });
});

describe("isPluginOfPlatform", () => {
    it("主键和匹配名都算这个插件的歌", () => {
        expect(isPluginOfPlatform(qqPlugin, "qq")).toBe(true);
        expect(isPluginOfPlatform(qqPlugin, "QQ音乐")).toBe(true);
    });

    it("显示名不算，别家的歌也不属于这个插件", () => {
        expect(isPluginOfPlatform(qqPlugin, "腾讯音乐")).toBe(false);
        expect(isPluginOfPlatform(qqPlugin, "netease")).toBe(false);
    });

    it("内部平台标识也算这个插件的歌", () => {
        expect(
            isPluginOfPlatform(
                { name: "QQ音乐", displayName: "QQ音乐", matchNames: [], channel: "qq" },
                "qq",
            ),
        ).toBe(true);
        /** 空串不能和任何未设置 channel 的插件相等 */
        expect(isPluginOfPlatform(qqPlugin, "")).toBe(false);
    });
});

describe("canonicalPlatform", () => {
    setPlatformCandidatesProvider(() => plugins);

    it("匹配名归回主键：同一首歌不该因为换过插件变成两条", () => {
        expect(canonicalPlatform("QQ音乐")).toBe("qq");
    });

    it("本来就是主键时不动", () => {
        expect(canonicalPlatform("qq")).toBe("qq");
    });

    it("认不出的原样返回，交给上层按未知平台处理", () => {
        expect(canonicalPlatform("酷狗音乐")).toBe("酷狗音乐");
    });

    /**
     * 插件列表是异步装载的。启动初期查不到就把「认不出」缓存住的话，
     * 之后插件装好了也纠正不回来：判重算成两首歌、取源静默失败，且不报错。
     */
    it("插件装载晚于第一次归一时，结果要能纠正回来", () => {
        invalidatePlatformCache();
        setPlatformCandidatesProvider(() => []);
        expect(canonicalPlatform("QQ音乐")).toBe("QQ音乐");

        setPlatformCandidatesProvider(() => plugins);
        expect(canonicalPlatform("QQ音乐")).toBe("qq");

        setPlatformCandidatesProvider(() => plugins);
    });
});

describe("canonicalPlatform 缓存", () => {
    /**
     * 判重是拿每首歌比每首歌：导入 3000 首就是约 900 万次比较。
     * 每次都扫一遍插件列表（还要读匹配名）会把 JS 线程卡到「应用无响应」，
     * 所以同一个平台名只允许查一次插件表。用调用次数断言，不靠计时。
     */
    it("同一个平台名只查一次插件表", () => {
        invalidatePlatformCache();
        let providerCalls = 0;
        setPlatformCandidatesProvider(() => {
            ++providerCalls;
            return plugins;
        });

        for (let i = 0; i < 10000; ++i) {
            canonicalPlatform("QQ音乐");
        }
        expect(providerCalls).toBe(1);

        setPlatformCandidatesProvider(() => plugins);
    });

    it("匹配名变更或装卸插件后必须重查，否则用的是旧对应关系", () => {
        invalidatePlatformCache();
        let providerCalls = 0;
        setPlatformCandidatesProvider(() => {
            ++providerCalls;
            return plugins;
        });

        canonicalPlatform("QQ音乐");
        expect(providerCalls).toBe(1);
        invalidatePlatformCache();
        canonicalPlatform("QQ音乐");
        expect(providerCalls).toBe(2);

        setPlatformCandidatesProvider(() => plugins);
    });
});
