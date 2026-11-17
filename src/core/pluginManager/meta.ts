import getOrCreateMMKV from "@/utils/getOrCreateMMKV";
import { safeParse, safeStringify } from "@/utils/jsonUtil";
import { errorLog } from "@/utils/log";
import { getStorage, removeStorage } from "@/utils/storage";
import { invalidatePlatformCache } from "./platformMatch";

type IPluginPlatform = string;

interface IPluginMetaStorage {
    $version: number;
    order: Record<IPluginPlatform, number>;
    disabledPlugins: Array<IPluginPlatform>;
    [key: `${IPluginPlatform}.alternativePlugin`]: IPluginPlatform | null;
    [key: `${IPluginPlatform}.userVariables`]: Record<string, string>;
    [key: `${IPluginPlatform}.alias`]: string;
    [key: `${IPluginPlatform}.matchNames`]: string[];
}


const storage = getOrCreateMMKV("plugin-meta");

/** 匹配名只留这么多条：兜住历史写法够用，再多是白占存储 */
const MAX_MATCH_NAMES = 20;

class PluginMeta {
    private cachedDisabledPlugins: Set<IPluginPlatform> | null = null;
    /**
     * 显示名与匹配名的内存缓存。
     *
     * 必须缓存：platformMatch 在取源、列表渲染、歌单判重里被高频调用
     * （导入几千首就是几百万次比较）。每次都比较一遍 MMKV 取出来的串，会把 JS 线程卡到「应用无响应」。
     * 这两个值只有 setPluginAlias / setPluginMatchNames 会改，写入时同步更新缓存就够。
     */
    private cachedAlias = new Map<IPluginPlatform, string | null>();
    private cachedMatchNames = new Map<IPluginPlatform, string[]>();

    /** 第一次读落到存储，之后走内存 */
    private cachedRead<T>(
        cache: Map<IPluginPlatform, T>,
        key: IPluginPlatform,
        read: () => T,
    ): T {
        if (!cache.has(key)) {
            cache.set(key, read());
        }
        return cache.get(key)!;
    }

    private getMetaStorage<K extends keyof IPluginMetaStorage>(key: K): IPluginMetaStorage[K] | null {
        return safeParse(storage.getString(key));
    }

    private setMetaStorage<K extends keyof IPluginMetaStorage>(key: K, value: IPluginMetaStorage[K]) {
        const storageValue = safeStringify(value);
        storage.set(key, storageValue);
    }

    async migratePluginMeta() {
        const metaVersion = storage.getNumber("$version") ?? -1;
        if (metaVersion < 0) {
            // 从async storage迁移到mmkv

            try {
                const rawMeta = await getStorage("plugin-meta");
                const order: Record<IPluginPlatform, number> = {};
                const disabledPlugins = new Set<IPluginPlatform>();

                if (rawMeta !== null) {
                    for (let platformName in rawMeta) {
                        const metaVal = rawMeta[platformName];
                        if (!metaVal) {
                            continue;
                        }
                        if (metaVal?.order !== undefined && metaVal.order !== null) {
                            order[platformName] = metaVal.order;
                        }
                        if (metaVal?.enabled !== undefined && metaVal.enabled === false) {
                            disabledPlugins.add(platformName);
                        }
                        if (metaVal?.userVariables !== undefined && metaVal.userVariables !== null) {
                            storage.set(platformName + ".userVariables", safeStringify(metaVal.userVariables));
                        }
                    }
                }
                // 将 order 和 disabledPlugins 存储到 mmkv
                storage.set("order", safeStringify(order));
                storage.set("disabledPlugins", safeStringify(Array.from(disabledPlugins)));

                // 移除
                await removeStorage("plugin-meta");
            } catch (e) {
                errorLog("迁移 plugin meta 失败", e);
            }


            storage.set("$version", 1);
        }

        /**
         * v2：平台解析不再看显示名与历史别名，改由 matchNames 认领。
         * 升级时把旧的历史别名和当前显示名一次性并进匹配名，
         * 否则存量歌单里存着旧写法的曲目会全部解析不到插件。
         */
        if ((storage.getNumber("$version") ?? 0) < 2) {
            /** 旧版本里显示名连同历史别名都参与解析，两种都要并进匹配名 */
            const platforms = new Set<IPluginPlatform>();
            const oldKeys = storage.getAllKeys();
            oldKeys.forEach(key => {
                for (const suffix of [".alias", ".aliasHistory"]) {
                    if (key.endsWith(suffix)) {
                        platforms.add(key.slice(0, -suffix.length));
                    }
                }
            });

            platforms.forEach(platformName => {
                const merged = this.normalizeMatchNames(platformName, [
                    ...(safeParse(storage.getString(`${platformName}.matchNames`)) ?? []),
                    safeParse(storage.getString(`${platformName}.alias`)),
                    ...(safeParse(storage.getString(`${platformName}.aliasHistory`)) ?? []),
                ]);
                if (merged.length) {
                    storage.set(`${platformName}.matchNames`, safeStringify(merged));
                }
            });

            oldKeys.forEach(key => {
                if (key.endsWith(".aliasHistory")) {
                    storage.delete(key);
                }
            });
            storage.set("$version", 2);
        }
    }

    getPluginOrder() {
        return this.getMetaStorage("order") ?? {};
    }

    setPluginOrder(orderMap: Record<IPluginPlatform, number>) {
        this.setMetaStorage("order", orderMap);
    }


    public get disabledPlugins() {
        if (this.cachedDisabledPlugins) {
            return this.cachedDisabledPlugins;
        }
        const disabledPlugins = this.getMetaStorage("disabledPlugins") ?? [];
        this.cachedDisabledPlugins = new Set(disabledPlugins);
        return this.cachedDisabledPlugins;
    }

    isPluginEnabled(pluginPlatform: IPluginPlatform) {
        const disabledPluginsSet = this.disabledPlugins;
        return !disabledPluginsSet.has(pluginPlatform);
    }


    setPluginEnabled(pluginPlatform: IPluginPlatform, enabled: boolean) {
        const disabledPluginsSet = this.disabledPlugins;

        if (enabled) {
            disabledPluginsSet.delete(pluginPlatform);
        } else {
            disabledPluginsSet.add(pluginPlatform);
        }
        this.setMetaStorage("disabledPlugins", Array.from(disabledPluginsSet));
        this.cachedDisabledPlugins = disabledPluginsSet;
    }

    getUserVariables(pluginPlatform: IPluginPlatform) {
        const userVariables = this.getMetaStorage(`${pluginPlatform}.userVariables`) ?? {};
        return userVariables;
    }

    setUserVariables(pluginPlatform: IPluginPlatform, userVariables: Record<string, string>) {
        this.setMetaStorage(`${pluginPlatform}.userVariables`, userVariables);
    }

    setAlternativePlugin(pluginPlatform: IPluginPlatform, alternativePluginPlatform: IPluginPlatform) {
        this.setMetaStorage(`${pluginPlatform}.alternativePlugin`, alternativePluginPlatform);
    }

    getAlternativePlugin(pluginPlatform: IPluginPlatform): IPluginPlatform | null {
        const alternativePlugin = this.getMetaStorage(`${pluginPlatform}.alternativePlugin`);
        if (alternativePlugin) {
            return alternativePlugin;
        }
        return null;
    }

    /**
     * 音源显示名：只影响界面展示，不参与平台解析，也不写进曲目数据
     * （出站盖章用的是主键，见 plugin.getMediaSource）。空串等价于删除，即恢复默认名。
     */
    setPluginAlias(pluginPlatform: IPluginPlatform, alias: string) {
        if (alias) {
            this.setMetaStorage(`${pluginPlatform}.alias`, alias);
        } else {
            storage.delete(`${pluginPlatform}.alias`);
        }
        this.cachedAlias.set(pluginPlatform, alias || null);
    }

    getPluginAlias(pluginPlatform: IPluginPlatform): string | null {
        return this.cachedRead(this.cachedAlias, pluginPlatform, () =>
            this.getMetaStorage(`${pluginPlatform}.alias`),
        );
    }

    /**
     * 平台匹配名：曲目里出现的这些名字都算作本插件（换插件后靠它认领历史数据）。
     * 返回值只读，别就地改。
     */
    getPluginMatchNames(pluginPlatform: IPluginPlatform): string[] {
        return this.cachedRead(this.cachedMatchNames, pluginPlatform, () =>
            this.getMetaStorage(`${pluginPlatform}.matchNames`) ?? [],
        );
    }

    setPluginMatchNames(pluginPlatform: IPluginPlatform, names: string[]) {
        const normalized = this.normalizeMatchNames(pluginPlatform, names);
        this.setMetaStorage(`${pluginPlatform}.matchNames`, normalized);
        this.cachedMatchNames.set(pluginPlatform, normalized);
        invalidatePlatformCache();
    }

    /** 去空、去重、剔除主键自身，并截断到上限 */
    private normalizeMatchNames(
        pluginPlatform: IPluginPlatform,
        names: Array<string | null | undefined>,
    ): string[] {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const raw of names) {
            const name = raw?.trim();
            if (!name || name === pluginPlatform || seen.has(name)) {
                continue;
            }
            seen.add(name);
            result.push(name);
            if (result.length >= MAX_MATCH_NAMES) {
                break;
            }
        }
        return result;
    }
}


const _internalPluginMeta = new PluginMeta();
 
export default _internalPluginMeta;