/**
 * 平台名与插件的匹配规则。
 *
 * 曲目入库时 platform 落的是插件主键，但历史/备份导入的数据里可能存着别的写法
 * （换个作者的插件后主键也完全不同）。所以按 platform 找插件时只认两样：
 * 插件主键，以及用户为该插件维护的匹配名。
 *
 * 显示名（displayName）只用于界面展示，不参与解析——改名不会再让存量曲目找不到插件。
 */

/** 参与匹配所需的名字，Plugin 结构上满足这个接口 */
export interface IPlatformCandidate {
    /** 插件内部主键，也是所有 meta 存储（排序/禁用/变量/别名/匹配名）用的键 */
    name: string;
    /** 当前展示名：只用于界面显示，不参与解析 */
    displayName: string;
    /** 手动维护的匹配名。曲目里出现这些名字都算作本插件 */
    matchNames: ReadonlyArray<string>;
    /**
     * 插件自己声明的展示名（插件导出里的 `name`，如「QQ音乐」）。
     * 本端曲目存的是 platform 主键（qq），但别的客户端/旧备份存的是这个名字，
     * 不认它的话那批曲目一律找不到插件、点歌即失败。
     */
    declaredName?: string;
}

/**
 * 按平台名找插件：主键优先，其次匹配名，最后才认插件自己声明的展示名。
 *
 * 分成几趟而不是一趟里 or，是为了「某插件的匹配名恰好等于另一个插件的真实主键」时主键必胜，
 * 结果不随插件列表顺序漂。
 */
export function findPluginByPlatform<T extends IPlatformCandidate>(
    platform: string,
    plugins: T[],
): T | undefined {
    return (
        plugins.find(_ => _.name === platform) ??
        plugins.find(_ => _.matchNames.includes(platform)) ??
        plugins.find(_ => !!platform && _.declaredName === platform)
    );
}

/** 这个曲目是不是这个插件的（主键、匹配名、插件声明的展示名任一命中即算） */
export function isPluginOfPlatform(
    plugin: IPlatformCandidate,
    platform: string,
): boolean {
    return (
        plugin.name === platform ||
        plugin.matchNames.includes(platform) ||
        (!!platform && plugin.declaredName === platform)
    );
}

/**
 * 插件列表由 PluginManager 注入。
 * 这里不直接 import PluginManager：mediaUtils 要用归一化，而 pluginManager 又依赖 mediaUtils，
 * 直接引会绕成循环。
 */
let candidatesProvider: (() => IPlatformCandidate[]) | null = null;

export function setPlatformCandidatesProvider(provider: () => IPlatformCandidate[]) {
    candidatesProvider = provider;
}

/**
 * 平台名归一成主键。
 *
 * 同一首歌在库里可能存成 `qq@123`，也可能存成 `QQ音乐@123`（历史数据或别的插件写法），
 * 判重、算唯一键时必须落到主键上，否则一个人会变成两首歌。
 * 认不出来就原样返回，绝不瞎猜。
 */
/**
 * 归一结果缓存。
 *
 * 判重会拿每首歌去比每首歌：导入 N 首就是 N² 次比较。这里不缓存的话，每次比较都要
 * 把插件列表扫一遍（还要读别名），几千首就能把 JS 线程卡到「应用无响应」。
 * 键是曲子里那个原始 platform 串，种类只有平台数那么多。
 */
let canonicalCache = new Map<string, string>();

/** 插件增减或有人改名，缓存的对应关系就不再成立，整体作废 */
export function invalidatePlatformCache() {
    canonicalCache = new Map();
}

export function canonicalPlatform(platform: string): string {
    const cached = canonicalCache.get(platform);
    if (cached !== undefined) {
        return cached;
    }
    const matched = findPluginByPlatform(platform, candidatesProvider?.() ?? [])?.name;
    if (matched === undefined) {
        /**
         * 认不出的不入缓存。插件列表是异步装载的，启动初期查不到不代表以后查不到；
         * 把「暂时认不出」缓存成原样，之后就会一直算错，判重和取源都跟着错，且没有任何提示。
         * 代价只是认不出的那些要重扫一遍插件表——别名读取已缓存，扫描本身很便宜。
         */
        return platform;
    }
    canonicalCache.set(platform, matched);
    return matched;
}
