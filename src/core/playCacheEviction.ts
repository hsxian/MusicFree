/**
 * 播放缓存的容量淘汰策略：只算该删谁，不碰文件系统（IO 在 playCache 里）。
 */

/** 缓存索引条目 */
export interface ICacheEntry {
    /** 不带 file:// 的绝对路径 */
    path: string;
    /** 字节数，容量淘汰依据 */
    size: number;
    /** 最近一次被播放的时间，LRU 依据 */
    lastAccess: number;
}

/** 按 lastAccess 升序淘汰到总量不超限；单条就超限时会一路删到空，否则永远无法收敛 */
export function pickEvictionTargets(
    entries: Array<[string, ICacheEntry]>,
    limit: number,
): string[] {
    let total = entries.reduce((sum, [, entry]) => sum + entry.size, 0);
    const targets: string[] = [];
    if (total <= limit) {
        return targets;
    }
    for (const [key, entry] of entries
        .slice()
        .sort((a, b) => a[1].lastAccess - b[1].lastAccess)) {
        targets.push(key);
        total -= entry.size;
        if (total <= limit) {
            break;
        }
    }
    return targets;
}
