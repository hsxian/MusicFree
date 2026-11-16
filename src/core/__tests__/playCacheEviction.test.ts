import { describe, expect, it } from "@jest/globals";
import { pickEvictionTargets, type ICacheEntry } from "../playCacheEviction";

const entry = (size: number, lastAccess: number): ICacheEntry => ({
    path: `/cache/play/${lastAccess}.mp3`,
    size,
    lastAccess,
});

describe("pickEvictionTargets", () => {
    it("总量未超限不淘汰", () => {
        expect(
            pickEvictionTargets(
                [
                    ["a", entry(100, 1)],
                    ["b", entry(200, 2)],
                ],
                1000,
            ),
        ).toEqual([]);
    });

    it("总量刚好等于上限不淘汰", () => {
        expect(pickEvictionTargets([["a", entry(1000, 1)]], 1000)).toEqual([]);
    });

    it("先淘汰最久未播放的一条即可回到上限内", () => {
        const targets = pickEvictionTargets(
            [
                ["old", entry(300, 1)],
                ["new", entry(300, 3)],
                ["mid", entry(300, 2)],
            ],
            600,
        );
        expect(targets).toEqual(["old"]);
    });

    it("需要淘汰多条时按 lastAccess 升序", () => {
        const targets = pickEvictionTargets(
            [
                ["a", entry(400, 3)],
                ["b", entry(400, 1)],
                ["c", entry(400, 2)],
            ],
            400,
        );
        expect(targets).toEqual(["b", "c"]);
    });

    it("单条即超限时全部淘汰才能收敛", () => {
        expect(
            pickEvictionTargets(
                [
                    ["a", entry(100, 1)],
                    ["b", entry(900, 2)],
                ],
                50,
            ),
        ).toEqual(["a", "b"]);
    });

    it("空目录返回空且不抛错", () => {
        expect(pickEvictionTargets([], 1024)).toEqual([]);
    });

    it("不改动入参顺序", () => {
        const entries: Array<[string, ICacheEntry]> = [
            ["a", entry(10, 2)],
            ["b", entry(10, 1)],
        ];
        pickEvictionTargets(entries, 0);
        expect(entries.map(([key]) => key)).toEqual(["a", "b"]);
    });
});
